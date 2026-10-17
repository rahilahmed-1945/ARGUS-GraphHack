// Runs the M1 FalkorDB feature probe as the admin user (redis-cli inside the container; REDISCLI_AUTH carries
// the admin password from argus/.env so it is never on a command line).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./falkordb-probe.sh', import.meta.url));
const r = spawnSync('bash', [script, process.argv[2] ?? 'argus-falkordb'], { stdio: 'inherit', env: { ...process.env, REDISCLI_AUTH: process.env.ARGUS_ADMIN_PASSWORD ?? '' } });
process.exit(r.status ?? 1);
