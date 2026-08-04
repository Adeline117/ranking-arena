# Ingest Worker Topology and Ownership

Arena's ingest fleet serves customer-facing ranking freshness from two nodes
sharing one Supabase database and Upstash Redis. A source's
`arena.sources.fetch_region` selects a region-affine BullMQ queue.

| Logical node  | PM2 app                  | Required regions | Production cwd                                       |
| ------------- | ------------------------ | ---------------- | ---------------------------------------------------- |
| Mac Mini      | `arena-ingest-worker`    | `local`          | `/Users/adelinewen/ranking-arena-releases/<release>` |
| Singapore VPS | `arena-ingest-worker-sg` | `vps_sg`         | `/opt/arena-ingest`                                  |

The Mac owns local sources. SG owns geo-blocked CEX sources assigned to `vps_sg`.
As verified on 2026-07-24, `vps_jp` has no source, queued job, browser endpoint,
or runtime owner; do not advertise it in `INGEST_REGIONS`. Reintroducing it
requires one explicit owner plus a proven browser endpoint and a coordinated
source/queue migration. A required region must have exactly one logical owner;
neither missing, duplicate, nor combined-region owners are healthy.

## Runtime locations

- `/opt/arena-ingest` is the SG production directory. It is not a Git checkout.
  It contains the complete runtime source, package inputs, `node_modules`, logs,
  secrets excluded from sync, `DEPLOYED_SHA`, and `WORKER_RELEASE_ID`.
- `/opt/ranking-arena` is a stale checkout and is never a deployment source.
- Confirm SG ownership with `pm2 describe arena-ingest-worker-sg` and its exact
  `exec cwd`; do not infer it from a directory name or Git state elsewhere.
- The current Mac release predates the new transaction and has shared mutable
  dependencies. Do not create another release with that pattern. Use only the
  transactional local script after all of its pre-stop gates pass.

## Deploy to SG

Use **Actions → Deploy Ingest Worker (SG)** from `main`, provide the exact current
40-character `origin/main` SHA, and choose `code-only` or `full`. The workflow is
manual by design and its production Environment allows only the `main` ref.

For a read-only preview:

```bash
git fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
TARGET_SHA="$(git rev-parse origin/main)"
bash worker/deploy-ingest-sg.sh --target-sha="$TARGET_SHA" --dry-run
```

The mutating script stages and verifies a complete candidate while the current
worker remains online. It stops the sole PM2 owner only for the directory rename,
then requires fresh ready, full SHA, and release-ID evidence. When connectivity
and its token-fenced lease remain available, a failed cutover restores and proves
the complete previous release. Full operational details live in
`docs/INGEST_WORKER_DEPLOY.md`.

Docker and Compose are intentionally disabled as SG rollout paths. The image
workflow proves an OCI artifact can build and boot by digest; it does not grant
that artifact production ownership.

## Fleet topology and runtime drift

Fresh heartbeats publish logical node identity, process audit data, region
ownership, deployed SHA, deterministic worker release ID, and capture state. The
15-minute `/api/cron/worker-heartbeat-check` evaluator requires:

- one distinct owner for every required region (`local`, `vps_sg`);
- no duplicate region owner and no combined owner;
- well-formed fresh entries with capture enabled; and
- one valid `WORKER_RELEASE_ID` across the active fleet.

The release ID, not Git SHA alone, is the runtime drift identity. App-only
commits can have different SHAs while preserving identical worker bytes. SHA is
still retained as audit evidence.

Deployment log readiness and fleet readiness are different proofs. The current
deployment marker confirms that the restarted process emitted the expected
identity after startup. The cron independently evaluates what Redis currently
reports; neither proof should be described as the other.

## Known process-cardinality gap

The legacy roster is keyed by logical `WORKER_NODE_ID`. Two processes reusing
the same ID overwrite the same Redis field, so the roster cannot prove real
process cardinality even though the payload contains a PID. Authorized paths
reduce this risk by requiring one exact PM2 owner and disabling the Docker path,
but they do not close the data-model gap.

The complete fix requires a per-node Redis ownership lease plus an independent
per-boot instance record:

- a random owner token and monotonic lease epoch;
- atomic acquire, compare-renew, and compare-delete operations;
- fail-closed self-fencing before the lease can expire;
- no consumer, scheduler, failover, or heartbeat startup before ownership;
- fresh owner and contender instances grouped by logical node; and
- readiness failure on duplicate instances, contenders, or epoch mismatch.

Until that protocol is deployed to both nodes, do not claim that the heartbeat
roster alone rules out a manually started or malicious duplicate process.

## On-chain enrichment owner

`maint:onchain-enrich` is reconciled every 12 hours on the local BullMQ queue and
is the only recurring owner. The standalone `scripts/onchain-enrich-web3.mts`
entrypoint has been removed and must remain absent: it had no shared lock and
could duplicate provider spend and writes.

## SG dependency incident boundary

The 2026-06-30 outage was caused by concurrent or interrupted package installs
mutating the same live dependency tree. Packages appeared installed while
runtime files were missing, and the worker crash-looped. The durable lessons are:

- never install into live `/opt/arena-ingest/node_modules`;
- never delete the only working live dependency tree;
- build changed dependencies on a healthy Node 22 Linux x64 runner;
- validate resolution and actual imports before cutover; and
- switch code and dependencies as one complete candidate directory.

Do not revive the historical recovery loop of repeated installs or manual
package extraction. Use the bound CI artifact and transactional workflow.
