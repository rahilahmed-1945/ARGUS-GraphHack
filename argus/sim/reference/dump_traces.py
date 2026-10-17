"""Dump reference traces from the verbatim simulator for JS<->Python parity tests (tests/m3-sim.test.js).
Prints JSON: world round-1 ACT segments, the tick-40 world state, the processing ORDER, and the
F5 future ensemble (per-rollout violation counts and rollout 0's per-tick trace).
"""
import copy, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim_reference import ORDER, base_model, init_state, apply_iv, rollout, ensemble

def slim(trace):
    return [{'gp': o['gp'], 'served': o['served'], 'q': o['q'], 'viol': o['viol']} for o in trace]

def state_json(s):
    return {'q': s['q'], 'p': {f'{a}>{b}': v for (a, b), v in s['p'].items()},
            'hot': {f'{a}>{b}': v for (a, b), v in s['hot'].items()},
            'open': {f'{a}>{b}': v for (a, b), v in s['open'].items()}}

T, W = base_model('twin'), base_model('world')
act1, s30 = rollout(W, init_state(W), ['degrade:ledger-db'], math.inf, 30, 7)
act2, s40 = rollout(W, s30, [], 0, 10, 8)
f5 = copy.deepcopy(T)
for iv in ['retries_off:gateway>checkout', 'retries_off:checkout>payments']:
    apply_iv(f5, iv)
rec, med, trs, by_entry = ensemble(f5, s40, [], 0, 60, 102)
print(json.dumps({
    'order': ORDER,
    'world_act1': slim(act1), 'world_act2': slim(act2), 'state40': state_json(s40),
    'f5': {'recovered': rec, 'median': med, 'viol': [sum(o['viol'] for o in tr) for tr in trs],
           'rollout0': slim(trs[0]), 'by_entry': by_entry},
}))
