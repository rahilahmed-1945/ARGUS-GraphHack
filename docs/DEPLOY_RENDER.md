# ARGUS — ₹0 public deployment on Render (Free)

One Docker container runs FalkorDB 6.0.1 (localhost only) and the ARGUS command-center server. Nothing else is
needed. The deployed demo is the **same code, runtime and safety mechanisms as the local demo**: M5 decision authority,
minimality audits, the no-progress / ceiling / reject takeovers, B5 autopilot and the restricted `agent` ACL identity
all run unchanged inside the container.

## What the public sees, honestly

- **Default mode: `replay` of `cassettes/public-live-replay.json`** — a copy of the genuine live run recorded on
  17 Oct 2026 03:38 IST with `cohere/north-mini-code:free`. The UI badge reads `REPLAY`, and the provenance line reads
  `cassette · live OpenRouter run (UI) · R1 RED autopilot (max_turn) · R1 BLUE autopilot (no_progress) · R2 RED llm ·
  R2 BLUE autopilot (turn_ceiling)`. The runtime, graph forks, audits and world simulation execute live; only the agent
  decisions are replayed from the recording, and the one phase the model decided is labelled `llm`, the rest `autopilot`.
  Replay is never presented as live AI activity.
- **Control the system** (judge mode) runs the deterministic reference models live against the judge's changed graph —
  labelled `INTERACTIVE (scripted)`, not an LLM.
- **Live mode** (`ARGUS_UI_MODE=live`) is for an operator-attended judging slot only: it needs `OPENROUTER_API_KEY` and
  `ARGUS_LLM_MODEL`, and anonymous visitors cannot start a live run when `ARGUS_OPERATOR_TOKEN` is set — the operator
  opens the page as `https://<app>/?op=<token>` (the token is sent only inside control messages and removed from the
  address bar). `ARGUS_LIVE_MAX_RUNS_PER_DAY` caps live runs (the free provider quota is 50 requests/day ≈ 2 runs).

## Free-tier facts used (verified 17 Oct 2026)

Render Free web service: 0.1 CPU, 512 MB RAM, Docker and inbound WebSockets supported, spins down after 15 minutes
without traffic and wakes on the next request (about a minute), 750 instance-hours per workspace per month, no
persistent disk, no credit card required ([free](https://render.com/docs/free), [compute plans](https://render.com/docs/compute-plans),
[websockets](https://render.com/docs/websocket)). ARGUS needs no persistence.

## Environment variables (names only — set the values in Render's dashboard, never in the repo)

| Variable | Required | Value for the public deployment |
|---|---|---|
| `ARGUS_ADMIN_PASSWORD` | yes | any long random string (FalkorDB admin inside the container) |
| `ARGUS_AGENT_PASSWORD` | yes | any long random string (the restricted MCP identity) |
| `ARGUS_UI_MODE` | no | `replay` (default, public) · `live` (operator slot) · `autopilot` |
| `ARGUS_UI_CASSETTE` | no | `cassettes/public-live-replay.json` (default in the image) |
| `ARGUS_PUBLIC_COOLDOWN_MS` | recommended | `15000` — one run *started* per client address per 15 s (operator bypasses). Reset, the judge's configure and ATTACK AGAIN are never rate-limited: they are steps of one interaction. A refused start is answered with the reason and the wait, and the UI retries once by itself. |
| `OPENROUTER_API_KEY` | live only | secret |
| `ARGUS_LLM_MODEL` | live only | e.g. `cohere/north-mini-code:free` |
| `ARGUS_OPERATOR_TOKEN` | live only | a random string of 16+ characters |
| `ARGUS_LIVE_MAX_RUNS_PER_DAY` | live only | `2` |
| `ARGUS_UI_CEILING_MS` | live only | `30000` (local default stays 6000) |
| `ARGUS_LLM_MIN_INTERVAL_MS` | no | request pacing (default 4500 in live runs) |
| `ARGUS_REDIS_MAXMEMORY` | no | `160mb` default |

Set automatically by the image / platform: `PORT` (Render), `ARGUS_UI_HOST=0.0.0.0`, `ARGUS_FALKORDB_HOST=127.0.0.1`.
`.env` is never copied into the image (`.dockerignore`).

## Manual steps (performed by the maintainer)

1. Commit and push the repository (including `argus/`, `docs/`, `argus/cassettes/public-live-replay.json`).
2. Render → **New → Web Service** → connect the GitHub repo → **Root Directory** `argus` → **Runtime** Docker →
   **Instance type** Free → **Health Check Path** `/state`.
3. Add the environment variables above (at minimum the two passwords and `ARGUS_PUBLIC_COOLDOWN_MS=15000`).
4. Deploy. First build pulls `node:22-bookworm-slim` and `falkordb/falkordb:6.0.1`.
5. Open the `https://<service>.onrender.com` URL once before judging so the instance is awake; a cold start takes about
   a minute (wake) plus ~10 s (FalkorDB start, ACL bootstrap, graph reset).
6. For a live judging slot: set `ARGUS_UI_MODE=live`, `OPENROUTER_API_KEY`, `ARGUS_LLM_MODEL`, `ARGUS_OPERATOR_TOKEN`,
   `ARGUS_UI_CEILING_MS=30000`, `ARGUS_LIVE_MAX_RUNS_PER_DAY=2` (Render restarts the service), open `/?op=<token>`,
   run once, then switch `ARGUS_UI_MODE` back to `replay`.

## Local validation of the container (what was tested before deployment)

```bash
docker build -t argus-demo argus
docker run --rm --memory=512m --cpus=0.1 -p 10000:10000 -e PORT=10000 -e ARGUS_ADMIN_PASSWORD=... -e ARGUS_AGENT_PASSWORD=... -e ARGUS_PUBLIC_COOLDOWN_MS=15000 argus-demo
```

Checked: startup + ACL bootstrap, `GET /state` health, Socket.IO connect, a full replay run to `DEMO_COMPLETED`,
`reset`, memory high-water mark, and clean shutdown on `docker stop` (SIGTERM).

## Rollback

Delete the Render service (or suspend it). The repository changes are additive: without the deployment environment
variables every default is the previous local behaviour (`127.0.0.1:4173`, replay of `reference-scripted.json`, no
operator token, no cooldown, no daily cap). `.env`, the runtime, prompts, B5/M5 and the existing cassettes are untouched.
