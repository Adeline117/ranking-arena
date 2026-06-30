# Ingest Worker Topology & Deploy (two-node)

The arena ingest worker runs on **two nodes** sharing one Supabase DB + Upstash Redis.
A source's `arena.sources.fetch_region` decides which node crawls it (region-affine
BullMQ queues, `worker/src/ingest/queues.ts`).

| Node               | Host                 | pm2 app                  | `INGEST_REGIONS` | Runs from                                     | Git?                |
| ------------------ | -------------------- | ------------------------ | ---------------- | --------------------------------------------- | ------------------- |
| Mac Mini (primary) | local                | `arena-ingest-worker`    | `local,vps_jp`   | `/Users/adelinewen/ranking-arena` (this repo) | yes (`main`)        |
| Singapore VPS      | `root@45.76.152.169` | `arena-ingest-worker-sg` | `vps_sg`         | **`/opt/arena-ingest`**                       | **NO — rsync copy** |

## ⚠️ Gotchas (cost real debugging time 2026-06-29)

- **The SG ingest worker runs from `/opt/arena-ingest`, NOT `/opt/ranking-arena`.**
  `/opt/ranking-arena` on the SG box is a stale March `master` checkout (7000+ commits
  behind, on a dead branch) that the worker does **not** use — ignore it. Check
  `pm2 describe arena-ingest-worker-sg` → `exec cwd` to confirm.
- `/opt/arena-ingest` is **not a git repo** — it's an rsync'd copy of `lib/` + `worker/`
  - `node_modules`. There is no `git pull` deploy; use the script below.
- Region split: Mac consumes `local,vps_jp`; SG consumes `vps_sg`. A source set to
  `vps_sg` (binance/okx/bitmart/toobit + binance_spot — geo-blocked CEX) is crawled
  ONLY by SG. `local`-region pages that geo-redirect from the US IP (e.g. coinex's
  board page → homepage) cannot be crawled from the Mac and must move to a VPS region.

## Deploy to SG

```bash
# from project root on the Mac Mini, after pushing to main:
bash worker/deploy-ingest-sg.sh --dry-run   # inspect the changeset first
bash worker/deploy-ingest-sg.sh             # rsync → backup → npm ci (if lock changed) → restart → verify
```

The script excludes `.env`/`.git`/`node_modules`/logs, backs up `/opt/arena-ingest`
for rollback, stamps `DEPLOYED_SHA`, and does stop→sync→start to minimise scheduler
split-brain (`queues.ts:66-85`).

## ⚠️ SG box npm-install hazard (2026-06-30 — learned the hard way)

The SG VPS (2 GB RAM, Vultr) **cannot reliably run a full `npm install`/`npm ci`**:
the install exits 0 but **silently drops real `.js` files from a deterministic set
of packages** (observed: luxon, abitype, ccxt, …). Reproduced across npm + pnpm,
cache-clean, raised ulimit, freed memory, serial `--maxsockets 1`. The filesystem
reports clean (ext4 rw, space + inodes free, no dmesg errors) and a _manual_
single-package `npm pack && tar xzf` extracts the same files correctly — so it's
something about large concurrent extraction on this box. ROOT CAUSE STILL OPEN.

Consequences:

- **Do NOT blindly `npm ci` on `/opt/arena-ingest`** — it produces an incomplete
  node_modules and crash-loops the worker (`Cannot find module …`). `deploy-ingest-sg.sh`
  will hit this on any lock change until the box issue is fixed.
- **NEVER `rm -rf node_modules` on the working SG install** — the box can't cleanly
  rebuild it (this is how the 2026-06-30 outage happened).

If node_modules must be rebuilt, until the box is fixed: install, then for each
`Cannot find module X` the worker reports, repair that package surgically —
`cd /tmp && npm pack <pkg>@<ver> && tar xzf *.tgz && cp -a package/. /opt/arena-ingest/node_modules/<pkg>/`
— and restart, iterating until the worker reaches `ready`. Better: investigate the
box (disk SMART, FS, npm config/registry mirror, memory) or rebuild node_modules on
a healthy Linux x64 host and rsync the COMPLETE tree (platform-matched).

## Drift detection

Each worker publishes its commit in the heartbeat (`resolveDeployedSha()` in
`worker/src/ingest/heartbeat.ts`). The 15-min Vercel cron
`/api/cron/worker-heartbeat-check` alarms (Telegram) when ≥2 distinct SHAs are live —
i.e. a fix landed on one node but not the other. This exists because the SG node
once silently ran 18-day-old code across all geo-blocked sources.
