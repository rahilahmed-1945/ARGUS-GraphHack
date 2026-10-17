"""Print base_model(kind) from the verbatim reference simulator as JSON (tuple keys -> 'a>b').
Used by tests/topology.test.js to check the seeded graph against the canonical reference topology.
Usage: python dump_base_model.py twin|world
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim_reference import base_model

m = base_model(sys.argv[1])
m['edges'] = {f'{a}>{b}': e for (a, b), e in m['edges'].items()}
m['ces'] = {k: {**v, 'edge': list(v['edge'])} for k, v in m['ces'].items()}
print(json.dumps(m))
