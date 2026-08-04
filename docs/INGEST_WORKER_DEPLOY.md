# Ingest Worker Production Deployment Runbook

This runbook defines the authorized production paths for Arena's customer-facing
ingest workers. It replaces the incident-era Docker, shared-dependency, and
in-place install instructions. See `docs/INGEST_WORKER_TOPOLOGY.md` for fleet
ownership and monitoring semantics.

## Non-negotiable invariants

- A production mutation deploys one explicit 40-character commit that is still
  the exact current `origin/main`.
- A release that changes the verified position-history contracts must follow the
  staged [verified position-history rollout](./VERIFIED_POSITION_HISTORY_ROLLOUT.md).
  Its fixed order is RAW prerequisite, publication authority while the old
  runtime serves, both exact-release workers, same-SHA Deploy Gate/application
  promotion, and only then the 2C canary.
- Reviewed worker bytes are identified by both `DEPLOYED_SHA` and the
  deterministic `WORKER_RELEASE_ID` derived from committed runtime inputs.
- Never run `npm install` or `npm ci` in the live SG directory.
- SG has exactly one authorized PM2 owner. Docker and Compose are not production
  rollout paths.
- Candidate preparation and verification happen while the current worker stays
  online. PM2 stops only for the complete-directory cutover.
- A historical log line is not readiness evidence. Success requires a unique
  post-cutover marker followed by fresh ready, full SHA, and release-ID evidence.
- Do not bypass the worker's production database release-readiness gate.

## Verified position-history release sequencing

For the reviewed position-history `@2` release, keep `origin/main` frozen and
use the same 40-character current-main SHA for both migration files, both worker
owners, and the application candidate. Do not start either reviewed worker
after only the RAW prerequisite: it reads the publication tables before capture,
and those tables do not exist until the publication-authority migration.

After both migrations and their exact postflights pass, deploy `local` and
`vps_sg` through the normal transactions while the previously proven 2C
application remains in production. The pre-worker admission count must have
been exactly zero. Do not deliberately trigger the canary until both owners have
fresh exact SHA/release-ID heartbeats, attempt-bound capture enabled, and no
duplicate, stale, failover, or mixed-release owner.

Only then re-run the original Deploy Gate for that same SHA. Its protected
worker-fleet check is the authority for application promotion; an earlier Gate
run withholding promotion while either worker was missing is expected. Do not
create a no-op commit, use the deploy-force escape path, or manually promote the
Vercel candidate. Complete the exact `source_run_id` database/API/2C canary in
the staged rollout before unfreezing `main`.

## Sole SG deployment channel

Use **Actions → Deploy Ingest Worker (SG)** from the `main` workflow ref.

| Change                                                      | Input                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| `.npmrc`, `package.json`, and `package-lock.json` unchanged | `target_sha=<exact current main SHA>`, `mode=code-only` |
| Any dependency install input changed                        | `target_sha=<exact current main SHA>`, `mode=full`      |

Obtain the target without abbreviating it:

```bash
git fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
git rev-parse origin/main
```

The deploy job references the `ingest-sg-production` GitHub Environment. That
Environment must retain a selected-branch rule allowing only `main`. Its three
secrets are environment-scoped, never repository-scoped:

- `INGEST_SG_SSH_KEY`: dedicated Actions deploy private key.
- `INGEST_SG_HOST`: fixed `user@hostname` value.
- `INGEST_SG_KNOWN_HOSTS`: previously verified pinned host-key record.

Missing trust inputs fail the workflow. Do not replace the pinned record with
runtime `ssh-keyscan`, and do not copy the SSH secrets back to repository scope.

## What the workflow proves

In `full` mode, the build job:

1. validates and checks out the exact target;
2. proves it is current `origin/main`;
3. builds dependencies on Node 22 Linux x64 with deterministic `npm ci`;
4. resolves and actually imports every critical worker module; and
5. emits a six-field manifest binding target SHA, worker release ID, dependency
   input hash, Node major, architecture, and tarball SHA-256.

The deploy job independently recomputes and strictly parses that manifest. It
also rechecks current main, pinned SSH trust, and the live Node 22/x64 runtime.
Every third-party Action in this production workflow is pinned to a full commit.

`code-only` intentionally skips the artifact build. The remote transaction still
requires matching dependency inputs, Node 22/x64, and successful critical-module
loads from the isolated candidate. This proves the existing dependency tree is
currently usable; it does not claim a content identity for every dependency file.

## SG transaction

`worker/deploy-ingest-sg.sh` performs the executable safety checks:

1. Materialize only exact committed runtime inputs and derive
   `WORKER_RELEASE_ID`.
2. Acquire a token-fenced remote deploy lease before inspecting or mutating SG.
3. Reject running ingest containers and require exactly one online PM2 owner at
   `/opt/arena-ingest`.
4. Clone the complete live directory to an isolated candidate, sync exact code,
   prepare dependencies, import critical modules, and atomically write both
   identity stamps.
5. Recheck exact current main, then stop PM2 and rename the complete live and
   candidate directories.
6. Start PM2 from the exact canonical cwd and require fresh marker-bound ready,
   SHA, and release evidence.
7. Recheck main inside the transaction before declaring success.

If a post-stop step fails while SSH and the same lease remain available, the
script restores the complete previous directory, starts it, and requires fresh
rollback identity evidence. Loss of connectivity or the lease makes automatic
rollback unsafe; the script then fails loudly for supervised recovery. Retention
cleanup for old successful backups is best-effort and cannot turn a completed
cutover into a false deployment failure.

## Direct script modes

The GitHub workflow is the canonical mutating entrypoint. Direct use is for an
inspected maintainer operation and still requires exact current main.

```bash
git fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
TARGET_SHA="$(git rev-parse origin/main)"
bash worker/deploy-ingest-sg.sh --target-sha="$TARGET_SHA" --dry-run
```

- `--dry-run`: itemized preview; no remote mutation.
- `--code-only`: reuse the validated remote dependency tree only when all three
  dependency inputs match.
- `--from-artifact=<tgz> --artifact-manifest=<manifest>`: deploy a bound CI
  dependency artifact.
- Default full mode: reuse matching dependencies; refuse changed inputs unless
  the emergency-only `--force-npm-ci` flag is supplied.
- `--force-npm-ci`: install only inside the isolated candidate and require actual
  module loads before cutover. It never modifies live `node_modules`.

## Container deployment is disabled

`worker/Dockerfile.ingest` and the image workflow may build and digest-smoke a
quarantined OCI artifact, but that artifact is not an authorized production
rollout path. `worker/docker-run-sg.sh` exits with status 2 and
`worker/docker-compose.sg.yml` intentionally defines no services.

Do not deploy with `docker run`, Compose, or an SG-side image build. Container
cutover may be re-enabled only after it shares the same host ownership lease,
digest-bound transaction, single-owner cutover, readiness proof, and tested
automatic recovery as the canonical PM2 path.

## Mac Mini deployment is transactional and fail closed

Do not create a new release by symlinking the shared development
`node_modules`. That makes reviewed production code mutable after activation.
Do not use plain `pm2 restart`, which retains the old cwd.

`worker/deploy-ingest-local.sh` is the only authorized local rollout path. It
requires an exact current-main target, a real Node 22 arm64 binary, a canonical
single PM2 owner, enough disk, mode-0600 worker secrets, `INGEST_REGIONS=local`,
the metric-trust database contract, and real browser/Redis readiness before it
stops the current worker. Runtime state and logs may be shared; dependencies and
Playwright Chromium are release-owned.

The cutover writes a durable recovery journal before PM2 stop. It then requires
the exact direct worker entrypoint, Node arguments, PID, SHA, release ID, logical
node, and fresh Redis roster payload. Any failure restores and proves the exact
previous release; an interrupted or unproved recovery blocks subsequent deploys
for supervised handling.

Do not restore the retired standalone `onchain-enrich-web3.mts` crontab entries.
`maint:onchain-enrich` on the local BullMQ queue is the sole recurring owner.

## Failure handling

- A normal failed workflow leaves a non-zero result and the script attempts
  rollback while it owns the remote lease. That automatic complete-directory
  restore is valid only while the attempted cutover has not proved success.
- Do not manually delete, rename, or restart `/opt/arena-ingest`; doing so bypasses
  the transaction and can destroy the last consistent release pair.
- Inspect the workflow and PM2 logs. If exact rollback evidence was obtained,
  correct the cause and redeploy exact current main through the full workflow.
- If the script says rollback evidence is unavailable, freeze further deploys
  and perform supervised recovery with one operator. Preserve both live and
  backup directories before any change.
- Once either worker has successfully cut over for a staged contract release—or
  any verified publication has committed—do not manually return that owner to
  an old SHA. Recovery must be a reviewed revert or forward commit that first
  becomes the exact current `main`, followed by the controlled rollout for every
  affected owner. Preserve the exact admission/publication evidence throughout.

For a local `.arena-ingest-deploy-blocked` record, never delete the record merely
to retry. First preserve it and inspect its marker, phase, lock token, old release,
and candidate release. Prove that exactly one `arena-ingest-worker` PM2 entry is
online with the intended canonical cwd, interpreter, direct entrypoint, arguments,
and PID. Then require a fresh Redis roster payload for that same PID, logical node,
SHA, release ID, `local` region, and capture flag (the first legacy rollback may
instead use its documented legacy log plus Redis/ancestry proof). Run `pm2 save`.
Only after all evidence agrees may the operator archive and remove the same
token-bearing block record. If any identity is ambiguous, leave it in place and
preserve both releases.

## Concurrent development discipline

- Work in per-session worktrees via `scripts/new-session-worktree.sh <name>`.
- Commit and push one verified atomic slice at a time.
- Never run two SG deploy sessions; the workflow concurrency group and remote
  lease are additional enforcement, not permission to create another path.
