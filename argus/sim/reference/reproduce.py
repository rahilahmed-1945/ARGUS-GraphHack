"""Reproduce the ARGUS reference numbers (spec section 8) from the verbatim Appendix A simulator.

Follows Appendix A "How the reference-number table is produced" step by step.
Prints one PASS/FAIL line per expected value, writes actual.json, exits 1 on any FAIL.
"""
import copy, json, math, os, statistics as st, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim_reference import (Rng, ORDER, base_model, init_state, apply_iv,
                           rollout, ensemble, calibrate)

HERE = os.path.dirname(os.path.abspath(__file__))
INF = math.inf
ENTRIES = ['gateway', 'mobile-gw']


def with_ivs(m, ivs):
    m = copy.deepcopy(m)
    for iv in ivs:
        apply_iv(m, iv)
    return m


def viol_ticks(trace):
    return sum(o['viol'] for o in trace)


def band(trs):
    """p10/p90 of per-rollout violation ticks. Percentile method is unspecified in the
    spec; nearest-rank on the 16 sorted values is used and reported as such."""
    v = sorted(viol_ticks(tr) for tr in trs)
    nr = lambda q: v[max(0, math.ceil(q * len(v)) - 1)]
    return nr(0.10), nr(0.90)


def future(m, state0, faults, t_off, horizon, tag):
    rec, med, trs, by_entry = ensemble(m, state0, faults, t_off, horizon, tag)
    p10, p90 = band(trs)
    return dict(p_recover=rec, median=med, p10=p10, p90=p90,
                entry_median={e: st.median(by_entry[e]) for e in ENTRIES})


def sustained(m, faults, tag):
    rec, _, _, _ = ensemble(m, init_state(m), faults, 30, 90, tag)
    return 16 - rec


A = {}  # actual values, keyed like expected.json

# ---- P.1 PRNG parity vector -------------------------------------------------
r = Rng(1001)
A['P1_prng_seed1001'] = [r.u32() for _ in range(4)]

T = base_model('twin')
W = base_model('world')

FAULTS = ['degrade:' + n for n in ORDER if n not in ENTRIES] + \
         ['surge:gateway', 'surge:mobile-gw', 'deploy:CE-42', 'deploy:CE-17']

# ---- R1.2 / R1.3: RED checks round 1 (tag 101) ------------------------------
r12 = {f: sustained(T, [f], 101) for f in FAULTS}
A['R1_3_degrade_ledger_db_sustained'] = r12.pop('degrade:ledger-db')
A['R1_2_degrade_payments_sustained'] = r12['degrade:payments']
A['R1_2_other_singles_max_sustained'] = max(r12.values())

# ---- R1.1 healthy world (seed unspecified in spec; seed 7 used, informational) -
tr_h, _ = rollout(W, init_state(W), [], INF, 150, 7)
A['R1_1_healthy_min_goodput_seed7_INFO'] = round(min(min(o['gp'].values()) for o in tr_h), 4)

# ---- Round-1 world: ACT ticks 0-29 (seed 7), ticks 30-39 fault removed (seed 8)
act1, s30 = rollout(W, init_state(W), ['degrade:ledger-db'], INF, 30, 7)
act2, s40 = rollout(W, s30, [], 0, 10, 8)
A['R1_4_gateway_goodput_max_ticks_2_29'] = round(max(o['gp']['gateway'] for o in act1[2:]), 3)
A['R1_4_payments_served_ticks_2_29'] = sorted({round(o['served']['payments'], 6) for o in act1[2:]})
A['R1_5_gateway_goodput_max_ticks_30_39'] = round(max(o['gp']['gateway'] for o in act2), 3)

# ---- Round-1 futures from the tick-40 snapshot (tag 102), world checks seed 99
R1_FUT = {
    'F0': [], 'F1': ['scale_out:payments'], 'F2': ['scale_out:ledger-db'],
    'F3': ['retries_off:checkout>payments'], 'F4': ['breaker:checkout>payments'],
    'F5': ['retries_off:gateway>checkout', 'retries_off:checkout>payments'],
    'R1_13': ['cap_retries:gateway>checkout', 'retries_off:checkout>payments'],
}
obs = {}
for k, ivs in R1_FUT.items():
    f = future(with_ivs(T, ivs), s40, [], 0, 60, 102)
    wtr, _ = rollout(with_ivs(W, ivs), s40, [], 0, 60, 99)
    obs[k] = wtr
    A[f'{k}_p_recover'] = f['p_recover']
    A[f'{k}_median'] = f['median']
    A[f'{k}_p10_p90'] = [f['p10'], f['p90']]
    A[f'{k}_world_viol'] = viol_ticks(wtr)
    A[f'{k}_entry_median_gw_mgw'] = [f['entry_median'][e] for e in ENTRIES]

# ---- R1.12 calibration: ACT ticks 0-39 + OBSERVE ticks with the selected fix (F5)
world_ticks = act1 + act2 + obs['F5']
cal_pay = calibrate(world_ticks, 'payments')
cal_led = calibrate(world_ticks, 'ledger-db')
A['R1_12_payments_cap_mean'] = round(cal_pay['cap_mean'], 1)
A['R1_12_payments_n'] = cal_pay['n']
A['R1_12_payments_se'] = round(cal_pay['se'], 1)
A['R1_12_payments_cap_sd_abs'] = round(cal_pay['cap_sd'] * cal_pay['cap_mean'], 1)
A['R1_12_ledger_db_result'] = cal_led  # expected None (n = 6 < 10)

# ---- Round 2: twin hardened (both retries_off, payments cap from calibration, sd 0.03)
HARD = ['retries_off:gateway>checkout', 'retries_off:checkout>payments']
T2 = with_ivs(T, HARD)
T2['svc']['payments']['cap'] = cal_pay['cap_mean']
T2['svc']['payments']['sd'] = cal_pay['cap_sd']
W2 = with_ivs(W, HARD)

r23 = {f: sustained(T2, [f], 201) for f in FAULTS}
A['R2_3_singles_max_sustained'] = max(r23.values())
SCEN = ['degrade:ledger-db', 'deploy:CE-42']
A['R2_4_ledger_db_plus_CE42_sustained'] = sustained(T2, SCEN, 201)
pairs = [(FAULTS[i], FAULTS[j]) for i in range(len(FAULTS)) for j in range(i + 1, len(FAULTS))]
others = [sustained(T2, list(p), 201) for p in pairs if set(p) != set(SCEN)]
A['R2_4_other_44_pairs_max_sustained_tag201_INFO'] = max(others)

R2_FUT = {'G0': [], 'G1': ['block_deploy:CE-42'], 'G2': ['breaker:orders>ledger-db'],
          'G3': ['scale_out:ledger-db']}
for k, ivs in R2_FUT.items():
    f = future(with_ivs(T2, ivs), init_state(T2), SCEN, 30, 90, 202)
    wtr, _ = rollout(with_ivs(W2, ivs), init_state(W2), SCEN, 30, 90, 77)
    A[f'{k}_p_recover'] = f['p_recover']
    A[f'{k}_median'] = f['median']
    A[f'{k}_p10_p90'] = [f['p10'], f['p90']]
    A[f'{k}_world_viol'] = viol_ticks(wtr)
    A[f'{k}_entry_median_gw_mgw'] = [f['entry_median'][e] for e in ENTRIES]

wtr, _ = rollout(W2, init_state(W2), ['degrade:ledger-db'], 30, 90, 77)
A['R2_8_world_trigger_alone_viol'] = viol_ticks(wtr)
A['R2_8_world_trigger_alone_recovered'] = not any(o['viol'] for o in wtr[-10:])

# ---- Compare ----------------------------------------------------------------
with open(os.path.join(HERE, 'expected.json')) as fh:
    E = json.load(fh)
with open(os.path.join(HERE, 'actual.json'), 'w') as fh:
    json.dump(A, fh, indent=2)

fails = 0
for key, spec in E.items():
    if key.startswith('_'):
        continue
    exp, act = spec['expected'], A.get(key, '<missing>')
    rule = spec.get('check', 'eq')
    if rule == 'eq':
        ok = act == exp
    elif rule == 'lt':
        ok = act != '<missing>' and act < exp
    elif rule == 'all_eq':
        ok = isinstance(act, list) and len(act) > 0 and all(v == exp for v in act)
    else:
        ok = False
    fails += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {key:48s} expected={json.dumps(exp):18s} actual={json.dumps(act)}   [{spec['ref']}]")

for key in sorted(k for k in A if k.endswith('_INFO')):
    print(f"INFO  {key:48s} actual={json.dumps(A[key])}")

print(f"\n{len([k for k in E if not k.startswith('_')]) - fails} passed, {fails} failed")
sys.exit(1 if fails else 0)
