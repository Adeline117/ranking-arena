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

## Sole SG deployment channel (currently suspended)

During the V1 incident NO-GO there is no authorized SG mutation channel:
`.github/workflows/deploy-ingest-sg.yml` has only an internal `workflow_call`
trigger and every job is fixed to `if: false`. Do not call it from another
workflow or bypass it with the direct script. After the owner closes every
release gate, restores the protected environment and explicitly re-enables the
reviewed jobs, a reviewed protected-main caller invoking this reusable workflow
is the sole channel. Arbitrary-ref `workflow_dispatch` must not return. Its
restored inputs are:

| Change                                                      | Input                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| `.npmrc`, `package.json`, and `package-lock.json` unchanged | `target_sha=<exact current main SHA>`, `mode=code-only` |
| Any dependency install input changed                        | `target_sha=<exact current main SHA>`, `mode=full`      |

Obtain the target without abbreviating it:

```bash
git fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main
git rev-parse origin/main
```

The deploy job references the `ingest-sg-production` GitHub Environment. Before
workflow restoration, that Environment must gain a required reviewer and a
selected-branch rule allowing only protected `main`. Its three
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

The restored GitHub workflow is the canonical mutating entrypoint. During the
current NO-GO, direct use is limited to `--dry-run`; the mutating modes below are
reference material for an owner-approved, supervised recovery only and still
require exact current main plus every stopped-recovery gate.

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
- `--recover-from-stopped`: explicit stopped-baseline recovery. It is mutually
  exclusive with `--dry-run`, requires both incident holds plus a fresh
  host-created one-time confirmation, and does not make an ordinary deployment
  accept a stopped worker.

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

## Incident deployment hold

The current incident uses a host-owned, durable deploy hold. It is independent
of Git, the candidate SHA, PM2, and GitHub environment approval:

- Mac mini: `~/ranking-arena/.arena-ingest/ingest-deploy.hold`
- Singapore: `/opt/arena-ingest.deploy-hold`

Any real file or symlink at either path blocks a mutating deployment. The local
transaction checks before candidate preparation, after taking its deploy lock,
and again immediately before PM2 cutover. The SG transaction checks before lock
creation and on every token-fenced lease assertion; a hold armed during a run
therefore cannot be bypassed by continuing an already-started candidate. Read-
only dry-runs remain available.

During the 2026-08-03 NO-GO, both primary holds are armed. Compatibility guards
for the previously deployed orchestrators are armed at
`~/ranking-arena-releases/.arena-ingest-deploy-blocked` and
`/opt/arena-ingest.deploy-recovery-required` as an additional fail-closed layer.
No deploy-force input, workflow approval, PM2 restart, or current-main SHA may
clear or override these files.

Only the owner may authorize recovery after the execution-status runbook's
credential, staging, migration, restore, and release gates are all evidenced.
For a stopped-baseline recovery, do **not** remove either hold. Preserve the
existing hold records in the incident evidence bundle, create the one-time
confirmation described below, and use only the transactional deploy script.
Never start either PM2 app directly.

## Stopped-baseline recovery

Stopped recovery is a separate, explicit mode; ordinary deployment semantics are
unchanged. Before authorizing it, prove no deployment workflow is in progress
and both deploy-lock paths are absent. Both the primary incident hold and its
compatibility guard must remain armed:

- Mac mini:
  `~/ranking-arena/.arena-ingest/ingest-deploy.hold` and
  `~/ranking-arena-releases/.arena-ingest-deploy-blocked`.
- Singapore:
  `/opt/arena-ingest.deploy-hold` and
  `/opt/arena-ingest.deploy-recovery-required`.

Create the confirmation on the target host itself, as a regular, non-symlink
file owned by the deploy user with mode `0600`. The fixed paths are:

- Mac mini:
  `~/ranking-arena/.arena-ingest/recover-from-stopped.go`.
- Singapore:
  `/opt/arena-ingest.recover-from-stopped.go`.

The file is at most 1024 bytes and contains exactly four lines:

```text
arena.ingest-recover-from-stopped@1
target_sha=<exact-current-main-40-hex-sha>
expires_epoch=<unix-seconds-not-more-than-900-seconds-in-the-future>
nonce=<64-lowercase-hex-characters>
```

Generate the nonce inside a non-traced owner shell and write it with a shell
builtin so it never appears in a process argument or deploy output. For example,
after setting `TARGET_SHA` to exact current main:

```bash
set +x
umask 077
GO_PATH='/replace/with/the/exact/path/above'
EXPIRES_EPOCH="$(( $(date +%s) + 600 ))"
RECOVERY_NONCE="$(openssl rand -hex 32)"
{
  builtin printf '%s\n' \
    'arena.ingest-recover-from-stopped@1' \
    "target_sha=$TARGET_SHA" \
    "expires_epoch=$EXPIRES_EPOCH" \
    "nonce=$RECOVERY_NONCE"
} > "$GO_PATH.tmp"
chmod 600 "$GO_PATH.tmp"
mv "$GO_PATH.tmp" "$GO_PATH"
unset RECOVERY_NONCE
```

The script requires `expires_epoch` to be current and no more than 900 seconds
ahead, atomically moves the GO file inside its token-fenced deploy lock, and
validates it again. It never prints the nonce or places it in an SSH/process
argument. A failed consumption destroys the moved confirmation and removes only
the newly acquired lock, so authorization cannot be replayed.

Run the exact-current-main transaction with the new flag:

```bash
# Mac mini
ARENA_NODE_BIN=/absolute/path/to/node22 \
  bash worker/deploy-ingest-local.sh \
  --target-sha="$TARGET_SHA" --recover-from-stopped

# Singapore; add --code-only or the attested artifact arguments when applicable
bash worker/deploy-ingest-sg.sh \
  --target-sha="$TARGET_SHA" --recover-from-stopped
```

Before removing the primary hold, the scripts re-prove the stopped baseline:
PM2 live state, both `dump.pm2` generations, OS processes, Docker ownership,
and Redis roster contain no active ingest owner; future-dated roster ownership
is also rejected. They bind the old canonical directory, deployed SHA, release
ID, and mode-0600 environment digest. The SG transaction additionally rejects
ingest aliases in saved PM2 state, symlinked live/candidate directories, or a
candidate environment that differs from the stopped baseline.

Success removes the primary hold only for the token-fenced cutover, starts one
candidate, and requires exact SHA, release ID, PID, readiness-log, fresh Redis,
PM2 stability, and saved-state proof before reporting success. It then clears
the compatibility guard and destroys the consumed GO.

Any failure in a stopped-recovery session takes the stopped quarantine path,
never the ordinary old-release restart path. The candidate is stopped and
its SG PM2 entry is deleted. PM2 state is force-saved twice; on SG, a cut-over
old directory is restored only when its bound SHA/release/environment digests
agree. Both holds are re-created as mode-0600 regular files, and the consumed GO
is destroyed. The worker remains stopped. If any zero-owner or restore proof is
incomplete, treat the result as a continuing incident: leave both holds armed
and perform manual inspection; do not start the old release.

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
