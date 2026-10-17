// OpenRouter provider for the injected LLM interface used by RED and BLUE:
//     llm.complete({ system, messages, tools }) → { toolCalls: [{ name, args }] } | { text }
// OpenAI-compatible chat completions with tool calling, temperature 0 (spec §2/§14). Nothing here is
// RED/BLUE specific, and nothing in RED/BLUE is OpenRouter specific. Failures throw ProviderError; the
// runtime turns any throw (or a stall past its per-turn ceiling) into a takeover by B5.
export class ProviderError extends Error {
  constructor(message, { status, cause } = {}) { super(message, { cause }); this.status = status; }
}
export class ProviderConfigError extends Error {}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// Transcript (red.js / blue.js format) → OpenAI chat messages
export function toChatMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) });
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else throw new ProviderError(`unknown transcript role '${m.role}'`);
  }
  return out;
}

export const toChatTools = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// OpenAI chat message → interface reply. Unparseable arguments yield args: null, which the agent wrapper
// reports as unusable output (→ rejected → takeover after two in a row).
export function fromChatMessage(message) {
  const calls = message?.tool_calls ?? [];
  if (!calls.length) return { text: message?.content ?? '' };
  return {
    toolCalls: calls.map((c) => {
      let args = null;
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = null; }
      return { name: c.function?.name, args: args && typeof args === 'object' && !Array.isArray(args) ? args : null };
    }),
  };
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.model           a tool-calling model id (spec TBD #19: chosen by configuration)
 * @param {string} [o.baseUrl]
 * @param {number} [o.timeoutMs]     request timeout (the runtime also enforces its own per-turn ceiling)
 * @param {function} [o.fetch]       injectable fetch (tests)
 * @param {number} [o.minIntervalMs] pacing: minimum gap between the starts of two outbound requests (0 = none). Free routes
 *                                   are capped per minute (a live run hit "limited to 15 requests per minute"); the gap is
 *                                   enforced on actual outbound requests only, serialises concurrent callers through one
 *                                   queue, counts failed requests (a 429 is a request), and never retries anything. The wait
 *                                   happens inside complete(), so it counts toward the runtime's per-turn ceiling.
 * @param {function} [o.now]         injectable clock (tests)
 * @param {function} [o.sleep]       injectable sleep (tests)
 */
export const DEFAULT_MIN_INTERVAL_MS = 4500;   // 15 requests/minute = one per 4 s; 4.5 s keeps a margin under the cap

export function createOpenRouterLLM({ apiKey, model, baseUrl = OPENROUTER_DEFAULT_BASE_URL, timeoutMs = 30000, fetch: fetchImpl = globalThis.fetch,
  minIntervalMs = 0, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!apiKey) throw new ProviderConfigError('OPENROUTER_API_KEY is not set: live mode needs a key (use --mode replay or --mode autopilot without one)');
  if (!model) throw new ProviderConfigError('ARGUS_LLM_MODEL is not set: choose a tool-calling OpenRouter model id');
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) throw new ProviderConfigError(`minIntervalMs must be a non-negative integer of milliseconds, got ${JSON.stringify(minIntervalMs)}`);
  // pacing gate: callers queue in arrival order; each waits until minIntervalMs after the previous request START
  let lastStart = -Infinity;
  let gate = Promise.resolve();
  const pace = () => {
    const turn = gate.then(async () => {
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
    });
    gate = turn.catch(() => {});
    return turn;
  };
  return {
    provider: 'openrouter',
    model,
    minIntervalMs,
    async complete({ system, messages, tools }) {
      if (minIntervalMs > 0) await pace();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'ARGUS' },
          body: JSON.stringify({ model, temperature: 0, messages: toChatMessages(system, messages), tools: toChatTools(tools),
            tool_choice: 'auto', parallel_tool_calls: true }),
        });
      } catch (e) {
        throw new ProviderError(controller.signal.aborted ? `OpenRouter request timed out after ${timeoutMs} ms` : `OpenRouter request failed: ${e.message}`, { cause: e });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      if (!res.ok) throw new ProviderError(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
      let body;
      try { body = JSON.parse(text); } catch (e) { throw new ProviderError('OpenRouter returned non-JSON', { cause: e }); }
      if (body.error) throw new ProviderError(`OpenRouter error: ${body.error.message ?? JSON.stringify(body.error)}`, { status: body.error.code });
      const message = body.choices?.[0]?.message;
      if (!message) throw new ProviderError('OpenRouter returned no choices');
      return fromChatMessage(message);
    },
  };
}

// Live runs pace requests by default (ARGUS_LLM_MIN_INTERVAL_MS overrides; 0 disables). Tests that construct
// createOpenRouterLLM directly are unpaced unless they ask for it.
export function createLLMFromEnv(env = process.env, extra = {}) {
  const raw = env.ARGUS_LLM_MIN_INTERVAL_MS;
  const minIntervalMs = raw === undefined || raw === '' ? DEFAULT_MIN_INTERVAL_MS : Number(raw);
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) throw new ProviderConfigError(`ARGUS_LLM_MIN_INTERVAL_MS must be a non-negative integer of milliseconds, got '${raw}'`);
  return createOpenRouterLLM({ apiKey: env.OPENROUTER_API_KEY, model: env.ARGUS_LLM_MODEL, baseUrl: env.OPENROUTER_BASE_URL || undefined, minIntervalMs, ...extra });
}
