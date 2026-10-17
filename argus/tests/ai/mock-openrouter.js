// Offline stand-in for the OpenRouter HTTP API (POST {base}/chat/completions), for tests ONLY.
//
// The production provider (runtime/providers/openrouter.js) is used unchanged: tests hand it this module's fetch
// instead of the network one, so the real request mapping, tool-call parsing and error handling all run. Each
// request is translated back into the provider-agnostic transcript ({system, messages, tools}) and answered by a
// policy — a deterministic model that sees exactly what an LLM would see. Nothing here can reach FalkorDB, MCP or
// the network; this module imports nothing (see tests/ai/ai-offline.test.js, "the mock has no shortcut").

export const MOCK_BASE_URL = 'https://mock-openrouter.invalid/api/v1';
export const MOCK_MODEL = 'mock/argus-scripted';

// OpenAI chat-completions request body → the transcript the agent adapters build (red.js / blue.js format)
export function fromChatRequest(body) {
  const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
  const names = new Map();
  const messages = [];
  for (const m of body.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function.name);
        return { id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || '{}') };
      });
      messages.push({ role: 'assistant', toolCalls });
    } else if (m.role === 'tool') messages.push({ role: 'tool', toolCallId: m.tool_call_id, name: names.get(m.tool_call_id), content: m.content });
  }
  const tools = (body.tools ?? []).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  return { system, messages, tools };
}

// a policy reply → an OpenAI chat-completions response body
// reply: {toolCalls: [{name, args | rawArguments}]} | {text} | {message: <raw OpenAI message>}
export function toChatResponse(reply, n) {
  const message = reply.message ?? (reply.toolCalls?.length
    ? { role: 'assistant', content: null, tool_calls: reply.toolCalls.map((c, k) => ({ id: `call_${n}_${k}`, type: 'function',
      function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.args ?? {}) } })) }
    : { role: 'assistant', content: reply.text ?? '' });
  return { id: `mock-${n}`, object: 'chat.completion', model: MOCK_MODEL,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] };
}

const roleOf = (tools) => (tools.some((t) => t.name === 'simulate') ? 'red' : tools.some((t) => t.name === 'fork_and_simulate') ? 'blue' : 'unknown');

/**
 * @param {object} o
 * @param {{red?: object, blue?: object}} o.models   deterministic models with complete({system, messages, tools})
 * @param {function} [o.intercept]   (request, n) → undefined | {status, text} | {hang: true} | {reply}
 *                                   to inject transport-level behaviour (HTTP errors, stalls, raw replies)
 */
export function createMockOpenRouter({ models = {}, intercept = () => undefined } = {}) {
  const requests = [];
  async function fetch(url, init) {
    if (!String(url).startsWith(MOCK_BASE_URL)) throw new Error(`mock-openrouter: refused request to ${url}`);
    const body = JSON.parse(init.body);
    const transcript = fromChatRequest(body);
    const role = roleOf(transcript.tools);
    const turn = transcript.messages.filter((m) => m.role === 'assistant').length;
    const n = requests.length + 1;
    const request = { n, role, turn, url: String(url), headers: { ...init.headers }, body, ...transcript };
    requests.push(request);
    const forced = await intercept(request, n);
    if (forced?.hang) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (forced?.status) return { ok: forced.status < 400, status: forced.status, text: async () => forced.text ?? '' };
    let reply = forced?.reply;
    if (!reply) {
      const model = models[role];
      if (!model) throw new Error(`mock-openrouter: no model for role '${role}'`);
      reply = await model.complete({ system: transcript.system, messages: transcript.messages, tools: transcript.tools });
    }
    const out = toChatResponse(reply, n);
    request.response = out;
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  }
  return { fetch, requests };
}

// a model that answers turn k with script[k] (an interface reply, or a function of the request transcript)
export function scriptModel(script) {
  return {
    async complete(t) {
      const turn = t.messages.filter((m) => m.role === 'assistant').length;
      const step = script[Math.min(turn, script.length - 1)];
      return typeof step === 'function' ? step(t) : step;
    },
  };
}
