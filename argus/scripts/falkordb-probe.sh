#!/usr/bin/env bash
# M1 read-only FalkorDB feature probe (no npm dependencies; uses redis-cli inside the container).
# Usage: bash argus/scripts/falkordb-probe.sh [container]   (default container: argus-probe)
# Creates scratch graphs probe_twin / probe_fork only, and deletes them at the end.
C=${1:-argus-probe}
R() { if [ -n "$REDISCLI_AUTH" ]; then docker exec -e REDISCLI_AUTH "$C" redis-cli --no-auth-warning "$@"; else docker exec "$C" redis-cli "$@"; fi; }
Q() { R GRAPH.QUERY probe_twin "$1"; }
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1  (got: $3)"; PASS=$((PASS+1)); else echo "FAIL  $1  expected: $2  got: $3"; FAIL=$((FAIL+1)); fi; }

R GRAPH.DELETE probe_twin >/dev/null 2>&1; R GRAPH.DELETE probe_fork >/dev/null 2>&1

echo "== version"; R MODULE LIST | paste -sd' ' | grep -o 'name graph ver [0-9]*'

# ---- seed: spec section 8.1 twin topology (8 services, 9 CALLS) + degrade faults
Q 'UNWIND [["gateway",true,300,5000],["mobile-gw",true,150,5000],["auth",false,0,1500],["checkout",false,0,2000],["orders",false,0,1000],["payments",false,0,800],["inventory",false,0,4000],["ledger-db",false,0,550]] AS s CREATE (:Service {name:s[0], entry:s[1], ext_rps:s[2], cap_mean:s[3]})' >/dev/null
Q 'UNWIND [["gateway","auth",1,1],["gateway","checkout",1,2],["mobile-gw","auth",1,1],["mobile-gw","orders",1,0],["checkout","payments",1,3],["checkout","inventory",1,1],["orders","ledger-db",2,0],["orders","inventory",1,1],["payments","ledger-db",0.2,0]] AS e MATCH (a:Service {name:e[0]}),(b:Service {name:e[1]}) CREATE (a)-[:CALLS {fanout:e[2], retries:e[3], breaker:false}]->(b)' >/dev/null
Q 'MATCH (s:Service) WHERE coalesce(s.entry,false) = false MERGE (f:Fault {id:"degrade:"+s.name}) SET f.kind="cap_degrade" MERGE (f)-[:APPLIES_TO]->(s)' >/dev/null
check "seed: 8 services"  8  "$(Q 'MATCH (s:Service) RETURN count(s)' | sed -n 2p)"
check "seed: 9 CALLS"     9  "$(Q 'MATCH ()-[c:CALLS]->() RETURN count(c)' | sed -n 2p)"
check "seed: 6 faults"    6  "$(Q 'MATCH (f:Fault) RETURN count(f)' | sed -n 2p)"

echo "== GRAPH.COPY"
check "GRAPH.COPY twin->fork returns OK"         OK  "$(R GRAPH.COPY probe_twin probe_fork)"
check "fork has 8 services"                       8   "$(R GRAPH.QUERY probe_fork 'MATCH (s:Service) RETURN count(s)' | sed -n 2p)"
check "fork has 9 CALLS"                          9   "$(R GRAPH.QUERY probe_fork 'MATCH ()-[c:CALLS]->() RETURN count(c)' | sed -n 2p)"
R GRAPH.QUERY probe_fork 'MATCH (:Service {name:"checkout"})-[c:CALLS]->(:Service {name:"payments"}) SET c.retries = 0' >/dev/null
check "write to fork is isolated from twin"       3   "$(Q 'MATCH (:Service {name:"checkout"})-[c:CALLS]->(:Service {name:"payments"}) RETURN c.retries' | sed -n 2p)"
OUT=$(R GRAPH.COPY probe_twin probe_fork 2>&1)
case "$OUT" in OK) G=OK ;; *) G=ERROR ;; esac
check "GRAPH.COPY onto existing dest errors"      ERROR "$G"; echo "      message: $OUT"

echo "== GRAPH.DELETE"
check "GRAPH.DELETE fork"                          OK  "$(R GRAPH.DELETE probe_fork | head -c 2)"
check "fork key gone"                              0   "$(R EXISTS probe_fork)"
check "delete-then-copy succeeds"                  OK  "$(R GRAPH.COPY probe_twin probe_fork)"
R GRAPH.DELETE probe_fork >/dev/null

echo "== variable-length paths"
check "*1..5 from entries: paths to payments"      1   "$(Q 'MATCH p=(e:Service {entry:true})-[:CALLS*1..5]->(:Service {name:"payments"}) RETURN count(p)' | sed -n 2p)"
clean() { grep -v '^Cached\|^Query internal\|^Graph version'; }
check "*0..4 zero-length path supported (payments@0, ledger-db@1)" "payments:0,ledger-db:1" \
  "$(Q 'MATCH q=(s:Service {name:"payments"})-[:CALLS*0..4]->(d:Service) RETURN d.name + ":" + toString(length(q)) ORDER BY length(q)' | clean | sed -n '2,$p' | paste -sd,)"
check "*1..6 upstream of ledger-db (blast radius)" "orders:1,payments:1,checkout:2,mobile-gw:2,gateway:3" \
  "$(Q 'MATCH p=(u:Service)-[:CALLS*1..6]->(x:Service {name:"ledger-db"}) WITH u.name AS n, min(length(p)) AS h RETURN n + ":" + toString(h) ORDER BY h, n' | clean | sed -n '2,$p' | paste -sd,)"
check "trigger set beneath payments (spec 6.4b, min(length(q)) - 1)" "degrade:payments@0,degrade:ledger-db@1" \
  "$(Q 'MATCH q=(s:Service {name:"payments"})-[:CALLS*0..4]->(d:Service)<-[:APPLIES_TO]-(f:Fault) WITH f, min(length(q)) - 1 AS hops ORDER BY hops, f.id RETURN f.id + "@" + toString(hops)' | clean | sed -n '2,$p' | paste -sd,)"

echo "== amplifier + trigger query (spec 6.4 as corrected 2026-10-07, min_risk=2 as a CYPHER parameter)"
AMP='CYPHER min_risk=2 MATCH p = (e:Service {entry:true})-[:CALLS*1..5]->(s:Service)
WITH p, e, s, nodes(p) AS ns, relationships(p) AS rs
WITH p, s, reduce(L = toFloat(e.ext_rps), i IN range(0, size(rs)-1) |
       (CASE WHEN L > ns[i].cap_mean THEN ns[i].cap_mean ELSE L END)
       * rs[i].fanout
       * (CASE WHEN rs[i].breaker THEN 1 ELSE 1 + rs[i].retries END)
     ) AS worst_load
WITH p, s, worst_load / s.cap_mean AS overload
WHERE overload >= $min_risk
MATCH q = (s)-[:CALLS*0..4]->(d:Service)<-[:APPLIES_TO]-(f:Fault)
WITH p, s, overload, f, min(length(q)) - 1 AS hops
ORDER BY overload DESC, hops, f.id
RETURN [n IN nodes(p) | n.name] AS amplifier, s.name AS target, overload,
       collect(f.id + "@" + toString(hops)) AS triggers
LIMIT 5'
AMPOUT=$(Q "$AMP" | clean)
echo "$AMPOUT" | sed 's/^/      /'
check "amplifier row (spec 6.4 round 1)" \
  "[gateway, checkout, payments] payments 4.5 [degrade:payments@0, degrade:ledger-db@1]" \
  "$(echo "$AMPOUT" | sed -n '5,8p' | paste -sd' ')"

echo "== PageRank (spec 6.7 form)"
PR=$(Q 'CALL algo.pageRank("Service", "CALLS") YIELD node, score RETURN node.name, score ORDER BY score DESC, node.name')
echo "$PR" | sed 's/^/      /'
check "PageRank top = ledger-db"                   ledger-db "$(echo "$PR" | sed -n 3p)"

echo "== extras (not required for M1)"
RO=$(R GRAPH.RO_QUERY probe_twin 'CREATE (:X)' 2>&1)
echo "      GRAPH.RO_QUERY with CREATE -> $RO" | head -2
SP=$(Q 'MATCH (e:Service {name:"gateway"}),(t:Service {name:"ledger-db"}) MATCH p = shortestPath((e)-[:CALLS*]->(t)) RETURN [n IN nodes(p) | n.name]' 2>&1)
echo "      shortestPath in MATCH (spec 6.22 form) -> $(echo "$SP" | tr '\n' ' ' | cut -c1-110)"
SP2=$(Q 'MATCH (e:Service {name:"gateway"}),(t:Service {name:"ledger-db"}) RETURN [n IN nodes(shortestPath((e)-[:CALLS*]->(t))) | n.name]' 2>&1 | clean | sed -n 2p)
echo "      shortestPath in RETURN form -> $SP2"
echo "      GRAPH.CONFIG TIMEOUT -> $(R GRAPH.CONFIG GET TIMEOUT 2>&1 | paste -sd' ')"

R GRAPH.DELETE probe_twin >/dev/null 2>&1; R GRAPH.DELETE probe_fork >/dev/null 2>&1
echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
