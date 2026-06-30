# Ingest Worker Deploy — Runbook (2026-06-30)

How to deploy the Arena ingest worker safely, after the 2026-06-30 SG crash-loop
incident (a concurrent lock change made the deploy `npm ci` on the SG box → npm
dropped .js files → worker crash-loop → SG ingestion DOWN). The fixes below make
deploys reproducible and self-healing. See also `docs/INGEST_WORKER_TOPOLOGY.md`
(two-node topology + the npm hazard) and the plan in
`~/.claude/plans/zany-orbiting-lerdorf.md`.

## TL;DR — pick the path

| Your change                                                    | Path                                                     | Command                                        |
| -------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| Parser/logic, **no new dependency** (`package-lock` unchanged) | **code-only** (zero box risk)                            | `bash worker/deploy-ingest-sg.sh --code-only`  |
| **New/changed dependency** (`package-lock` changed)            | **CI artifact** (build deps on Linux-x64, ship the tree) | Actions tab → run `Deploy Ingest Worker (SG)`  |
| Mac Mini node (local/vps_jp)                                   | just restart — it runs from the live repo                | `pm2 restart arena-ingest-worker --update-env` |

**Golden rule: never run `npm install`/`npm ci` on the SG box.** Its npm is not
concurrency-safe and drops .js files under interruption. The script refuses it by
default; `--force-npm-ci` is a documented last resort only.

## The two nodes

- **Mac Mini** (`arena-ingest-worker`, regions `local,vps_jp`): runs `npx tsx
worker/src/ingest-worker.ts` from the live git checkout. **A `pm2 restart`
  picks up code changes** (tsx re-reads the .ts files — no build step).
- **Singapore VPS** (`arena-ingest-worker-sg`, region `vps_sg`: binance / okx /
  bitmart / toobit / binance_spot): runs from `/opt/arena-ingest`, a NON-git
  rsync copy. Deploy via the CI workflow or `worker/deploy-ingest-sg.sh`.

## CI artifact pipeline (the dependency-safe path)

`.github/workflows/deploy-ingest-sg.yml`:

1. **build-deps** (no secrets) — on `ubuntu-latest` (= SG's Linux-x64 arch):
   `npm ci` + `npx playwright install chromium` → **verifies the tree resolves**
   (require.resolve of bullmq/viem/luxon/abitype/esbuild/tsx/dotenv/… — a broken
   tree fails the build, never ships) → tars `node_modules` → uploads artifact.
2. **deploy-sg** (gated on secrets) — ships the artifact + runs
   `deploy-ingest-sg.sh --from-artifact=<tgz>`, which **swaps `node_modules`
   atomically** (`mv` rename; the `.bak` keeps the old tree) and **auto-rolls-back**
   if the worker doesn't report `ready`.

**Activation (one-time, maintainer):** add repo secrets `INGEST_SG_SSH_KEY`
(private key whose pubkey is in SG's `authorized_keys`) + `INGEST_SG_HOST`
(`root@45.76.152.169`) → run the workflow from the Actions tab → once green,
uncomment the `push:` trigger so dep changes auto-deploy. Until the secrets exist,
`build-deps` still runs (proves the artifact builds) and `deploy-sg` skips cleanly.

It is the **single channel** for SG deploys (a `concurrency` group serializes
runs) — never two sessions deploying at once, never concurrent `npm ci`.

## `worker/deploy-ingest-sg.sh` modes

- `--dry-run` — preview the rsync, no changes.
- `--code-only` — rsync `lib/ worker/ tsconfig.json` only (no `node_modules`,
  no npm). Refuses if `package-lock` actually changed.
- `--from-artifact=PATH.tgz` — ship a CI-built tree + atomic swap (what CI uses).
- _(default full)_ — refuses `npm ci` on a lock change; points you to CI.
- `--force-npm-ci` — last resort; runs the hazardous install, then verify `ready`
  and surgically repair any missing package (`npm pack` + `tar` + `cp`). **Never
  `rm -rf node_modules`** on the working install.

Every path: backup → graceful stop → sync → restart → verify `ready` →
**auto-rollback** (restores the code+node_modules pair from `.bak`) on failure.

## Recovery (if SG crash-loops on `Cannot find module`)

This is the incident signature. Do NOT npm-install to "fix" it. Either:

1. **Roll back** to the consistent pair: `ssh SG 'rm -rf /opt/arena-ingest && mv
/opt/arena-ingest.bak-<TS> /opt/arena-ingest && pm2 restart arena-ingest-worker-sg'`
   (the deploy script does this automatically now). Then redeploy via CI.
2. If you only have dep-free fixes to land, `--code-only` onto the rolled-back tree.

## Multi-session discipline (so deploys don't collide)

- Work in a **per-session worktree**: `scripts/new-session-worktree.sh <name>`
  (own branch, env + node_modules symlinked) → merge via the push lock. Roots out
  the shared-working-tree collisions that caused this incident.
- Keep concurrent sessions to **2–4**, not 7 (coordination + syspolicyd fork-storm).
- Worker deploy is one channel — see above. (CLAUDE.md 多会话编排纪律 rules 5–7.)
