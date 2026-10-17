// Creates argus/.env with random local database secrets if it does not exist. The file is git-ignored;
// secrets are never committed. Existing values are kept; missing keys are appended.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
const has = (k) => new RegExp(`^${k}=`, 'm').test(current);
const add = [];
for (const k of ['ARGUS_ADMIN_PASSWORD', 'ARGUS_AGENT_PASSWORD']) if (!has(k)) add.push(`${k}=${randomBytes(18).toString('base64url')}`);
if (add.length) appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
console.log(add.length ? `wrote ${add.length} new secret(s) to argus/.env` : 'argus/.env already has the database secrets');
