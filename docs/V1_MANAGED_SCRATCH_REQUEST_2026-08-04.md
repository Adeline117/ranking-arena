# Arena V1 managed scratch and capture request (2026-08-04)

## Status

Production remains **NO-GO**. No production migration, restore, worker start, or
deployment is authorized by this document.

The two Git-linked Preview projects for PRs #254 and #255 are not qualified
scratch environments. Both stopped at historical migration
`00008_admin_features.sql` with SQLSTATE `42703`; neither has a proved
PostgreSQL major version, capacity, healthy schema, or controlled database
connection. The current count of qualified managed scratch projects is zero.

## Owner-provided inputs

Provide these through an approved secret channel; do not commit them, paste
them into an issue or PR, or place them in shell history.

1. The production project's current **Server root certificate**, downloaded by
   an Owner/Admin from Dashboard -> Database Settings -> SSL Configuration.
   Store it outside the repository as a regular non-symlink file with owner-only
   permissions. Record only its SHA-256 in review evidence.
2. One dedicated read-only production **Direct** or **Session Pooler** URL on
   port `5432`. It must use the official DNS hostname and an audit role that
   cannot write. The capture process will require `sslmode=verify-full` and the
   explicit certificate path; transaction pooler port `6543` is not accepted.
3. Two distinct, disposable managed Supabase projects using PostgreSQL 17 for
   foundation -> baseline -> forward replay. Record project-ref hashes, region,
   exact PostgreSQL version, compute class, disk size, extension versions, and
   deletion owner. Do not reuse production or a failed Git Preview branch.
4. A separate managed restore target with at least 100 GiB available storage,
   preferably created through **Restore to a New Project** from an approved
   physical backup/PITR point. This target is not interchangeable with the two
   empty schema-replay projects.

## Isolation requirements

- Keep every scratch project unreachable from production application aliases,
  workers, cron, webhooks, and deployment secrets.
- Before inspecting a restored database, disable or quarantine `pg_cron`,
  `pg_net`, database webhooks, wrappers/foreign servers, replication
  subscriptions, and other outbound side effects. Preserve definitions as
  evidence; do not execute them.
- Do not copy production API keys, Edge Functions, Auth provider configuration,
  Storage objects, or worker credentials into schema-replay projects.
- Use distinct credentials for each target. URLs, passwords, CA bytes, JWTs,
  encryption keys, and user/business rows must never enter Git artifacts or
  command arguments.
- Set a deletion deadline and delete scratch resources only after evidence is
  exported and reviewed.

## Execution order

1. Wait for the Supabase Database degradation and Project Upgrade Delays
   incident to be resolved.
2. Validate the certificate and read-only 5432 connection without exposing the
   URL; prove PostgreSQL 17 and `transaction_read_only=on`.
3. Run the reviewed
   [`capture-canonical-baseline.mjs`](../scripts/maintenance/capture-canonical-baseline.mjs)
   command to capture application schema, normalized catalogue, and
   migration-ledger hashes from one exported repeatable-read, read-only
   snapshot. Select a canonical, owner-owned `0700` output parent; an incomplete
   marker means the claimed directory must not be consumed. Its completed output
   remains source evidence and must not be placed directly under
   `supabase/migrations`.
4. Construct and independently review one `candidate/not-deployable` artifact.
   Do not rewrite any applied historical migration.
5. Replay the exact foundation, app schema, and complete forward epoch on both
   empty managed PG17 projects. Compare normalized catalogue and ledger output.
6. Restore the protected backup to the >=100 GiB target and complete full stream
   CRC/tail, table/index/constraint counts, RLS/Auth, critical-row counts, and
   read-only application smoke checks.
7. Reconcile the restored source, both schema replays, Preview, and the approved
   V1 target. Any mismatch keeps production NO-GO.
8. Only after separate owner GO may the production deployment runbook begin;
   this request never grants that GO.

## Evidence receipt

The reviewer should receive only non-secret evidence:

- CA SHA-256 and certificate validity dates (not private credentials)
- hashed project refs and source identity
- exact PostgreSQL/extension versions and target sizing
- capture/candidate Git SHA and artifact hashes
- replay logs with credentials and connection identifiers removed
- catalogue/ledger comparison hashes and mismatch list
- restore verification counts, CRC/tail result, smoke result, and deletion
  receipts for disposable resources

## Official references

- [Postgres SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Direct, session-pooler, and transaction-pooler connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase Branching](https://supabase.com/docs/guides/deployment/branching)
- [Restore to a new project](https://supabase.com/docs/guides/platform/clone-project)
- [Compute and disk limits](https://supabase.com/docs/guides/platform/compute-and-disk)
