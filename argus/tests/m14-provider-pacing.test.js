// M14 — provider pacing. A live run of 17 Oct hit "High demand for <model>:free on OpenRouter - limited to 15 requests per
// minute" (HTTP 429 → llm_error → B5). The adapter now enforces a minimum gap between the starts of outbound requests:
// on by default for live runs (createLLMFromEnv, ARGUS_LLM_MIN_INTERVAL_MS overrides, 0 disables), off for adapters that
// tests construct directly. Deterministic: injected clock, sleep and fetch; no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterLLM, createLLMFromEnv, ProviderError, ProviderConfigError, DEFAULT_MIN_INTERVAL_MS } from '../runtime/providers/openrouter.js';
import { RED_TOOL_SCHEMAS } from '../runtime/red.js';

const KEY = 'offline-test-key';
const reply = (n) => JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'list_candidates', arguments: '{}' } }] } }] });

// a fake world: a clock that only advances through sleep() and through the fake fetch's own service time
function world({ serviceMs = 1000, statuses = [] } = {}) {
  let t = 0;
  const sleeps = [];
  const starts = [];
  const w = {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps, starts,
    fetch: async () => {
      const n = starts.length + 1;
      starts.push(t);
      t += serviceMs;
      const status = statuses[n - 1] ?? 200;
      return { ok: status < 400, status, text: async () => (status < 400 ? reply(n) : JSON.stringify({ error: { message: `limited to 15 requests per minute`, code: 429 } })) };
    },
  };
  return w;
}
const llm = (w, extra = {}) => createOpenRouterLLM({ apiKey: KEY, model: 'mock/x', fetch: w.fetch, now: w.now, sleep: w.sleep, ...extra });
const call = (m) => m.complete({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: RED_TOOL_SCHEMAS });

test('1. defaults: a directly constructed adapter is unpaced; createLLMFromEnv paces at the default; the env var overrides and 0 disables; bad values fail clearly', async () => {
  const w = world();
  const m = llm(w);
  assert.equal(m.minIntervalMs, 0);
  await call(m); await call(m); await call(m);
  assert.deepEqual(w.sleeps, [], 'no pacing waits');
  const env = { OPENROUTER_API_KEY: KEY, ARGUS_LLM_MODEL: 'mock/x' };
  assert.equal(createLLMFromEnv(env, { fetch: w.fetch }).minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 4500, 'one request per 4.5 s stays under 15 per minute');
  assert.equal(createLLMFromEnv({ ...env, ARGUS_LLM_MIN_INTERVAL_MS: '2000' }, { fetch: w.fetch }).minIntervalMs, 2000);
  assert.equal(createLLMFromEnv({ ...env, ARGUS_LLM_MIN_INTERVAL_MS: '0' }, { fetch: w.fetch }).minIntervalMs, 0);
  assert.throws(() => createLLMFromEnv({ ...env, ARGUS_LLM_MIN_INTERVAL_MS: 'fast' }, { fetch: w.fetch }), ProviderConfigError);
  assert.throws(() => createOpenRouterLLM({ apiKey: KEY, model: 'mock/x', minIntervalMs: -1 }), ProviderConfigError);
});

test('2. sequential requests start at least minIntervalMs apart, measured from the previous request START (service time counts toward the gap)', async () => {
  const w = world({ serviceMs: 1000 });
  const m = llm(w, { minIntervalMs: 4500 });
  await call(m); await call(m); await call(m);
  assert.deepEqual(w.starts, [0, 4500, 9000]);
  assert.deepEqual(w.sleeps, [3500, 3500], 'each wait is the gap minus the time already spent');
  // a request that itself took longer than the gap is followed immediately, with no wait
  const slow = world({ serviceMs: 6000 });
  const m2 = llm(slow, { minIntervalMs: 4500 });
  await call(m2); await call(m2);
  assert.deepEqual([slow.starts, slow.sleeps], [[0, 6000], []]);
});

test('3. concurrent callers are serialised through one queue: no duplicate requests, in arrival order, each paced, every caller gets its own reply', async () => {
  const w = world({ serviceMs: 500 });
  const m = llm(w, { minIntervalMs: 4500 });
  const replies = await Promise.all([call(m), call(m), call(m)]);
  assert.deepEqual(w.starts, [0, 4500, 9000], 'three outbound requests, spaced');
  assert.equal(replies.length, 3);
  assert.ok(replies.every((r) => r.toolCalls?.[0]?.name === 'list_candidates'));
});

test('4. HTTP 429 is a single ProviderError: no retry, no model switch; the failed request still occupies its slot, so the next request is paced from it', async () => {
  const w = world({ serviceMs: 100, statuses: [429, 200] });
  const m = llm(w, { minIntervalMs: 4500 });
  await assert.rejects(call(m), (e) => e instanceof ProviderError && e.status === 429 && /15 requests per minute/.test(e.message));
  assert.equal(w.starts.length, 1, 'exactly one outbound request for the failed call');
  const out = await call(m);
  assert.deepEqual(w.starts, [0, 4500], 'the 429 counted as a request against the cap');
  assert.equal(out.toolCalls[0].name, 'list_candidates');
  assert.equal(m.model, 'mock/x', 'the model is unchanged');
});

test('5. a request that fails at the transport level also releases the queue: later callers are not stuck', async () => {
  let t = 0; const starts = [];
  let first = true;
  const fetch = async () => { starts.push(t); t += 100; if (first) { first = false; throw new Error('ECONNRESET'); } return { ok: true, status: 200, text: async () => reply(2) }; };
  const m = createOpenRouterLLM({ apiKey: KEY, model: 'mock/x', fetch, now: () => t, sleep: async (ms) => { t += ms; }, minIntervalMs: 4500 });
  const [a, b] = await Promise.allSettled([call(m), call(m)]);
  assert.equal(a.status, 'rejected');
  assert.match(a.reason.message, /request failed: ECONNRESET/);
  assert.equal(b.status, 'fulfilled');
  assert.deepEqual(starts, [0, 4500]);
});
