// World clock (spec §2.3, §10 pacing). WORLD execution time advances only during ACT/OBSERVE; it is frozen
// while an agent decides (TWIN planning time). The simulator computes world ticks deterministically; the clock
// only paces their release. `virtual` pacing never sleeps (tests); `realtime` sleeps through an injectable
// sleep() for the live demo. Virtual time is accounted identically in both modes.

/* DISPLAY CONSTANTS — demo pacing (spec §2.3 / §10: 5 ticks/s, a 4 s hold on TRIGGER REMOVED). Not system-model data. */
export const PACING = Object.freeze({ TICKS_PER_SECOND: 5, TICK_MS: 1000 / 5, HOLD_MS: 4000 });
/* END DISPLAY CONSTANTS */

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWorldClock({ pacing = 'virtual', sleep = realSleep, events = null } = {}) {
  if (pacing !== 'virtual' && pacing !== 'realtime') throw new Error(`pacing must be 'virtual' or 'realtime'`);
  let virtualMs = 0;
  let state = 'paused';
  const set = (next, extra = {}) => { state = next; events?.emit('CLOCK', { state, virtual_ms: virtualMs, ...extra }); };
  const wait = async (ms) => { virtualMs += ms; if (pacing === 'realtime') await sleep(ms); };
  return {
    get state() { return state; },
    get virtualMs() { return virtualMs; },
    pacing,
    // TWIN planning: world frozen while an agent decides
    pause(reason) { set('paused', { reason }); },
    run(reason) { set('running', { reason }); },
    // one world tick released to observers
    async tick() { await wait(PACING.TICK_MS); },
    // the held moment (spec: "hold for 4 s on the TRIGGER REMOVED banner")
    async hold(reason, ms = PACING.HOLD_MS) { set('held', { reason, ms }); await wait(ms); },
  };
}
