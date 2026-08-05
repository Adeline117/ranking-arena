# Canonical baseline candidates

This directory is an evidence workspace for rebuilding a reproducible Supabase
schema baseline. It is intentionally outside `supabase/migrations`: nothing in
this directory is an active migration or an authorization to change a remote
database.

The current historical migration directory is hash-locked evidence, but it is
not fresh-replayable. A candidate must preserve that evidence instead of
rewriting old files to make a Preview check green.

## Candidate layout

Each versioned candidate directory must contain:

```text
app-schema.sql
forward-migrations.json
manifest.json
platform-prerequisites.json
source-catalog.json
```

- `app-schema.sql` is schema-only DDL for application-owned `public` and
  `arena` objects. It must contain no table data, migration-ledger writes,
  credentials, or managed `auth`/`storage` schema definitions, and it must
  retain the matching `\restrict`/`\unrestrict` envelope emitted by
  PostgreSQL 17.6 or newer.
- `source-catalog.json` is a normalized, one-way catalogue witness for the
  read-only source snapshot. It is not a dump of user rows.
- `platform-prerequisites.json` records the managed Supabase roles, schemas,
  relations, types, functions, and extensions supplied by the pinned disposable
  foundation before replay. Its six sorted arrays are compared with the
  foundation catalogue delta, so undeclared helper objects cannot silently
  satisfy an app-schema dependency.
- `forward-migrations.json` is the ordered, SHA-256-pinned list of reviewed
  forward migrations applied after the explicit `baselineThrough` boundary.
  The boundary must be the latest unique 14-digit version in the captured
  source ledger and must name an existing modern repository migration; a
  future or ledger-detached cutoff is invalid.
  Its paths are repository relative and must point to every newer 14-digit file
  under `supabase/migrations`; both each file and the complete set are hashed,
  so omission is a validation failure. SQL is never copied into the candidate
  directory. A second digest binds the complete modern repository migration
  inventory, including files at or before the boundary, so a later backdated
  addition invalidates the candidate instead of being silently absorbed into
  the baseline. The boundary starts a new forward epoch: every newer file must be
  harness-transaction-compatible and therefore contain no top-level transaction
  control or `CONCURRENTLY` operation.
- `manifest.json` pins the candidate status, PostgreSQL major version, source
  attestation, Git revision, the exact non-production foundation fixture, and
  the SHA-256 of every candidate artifact.

Candidate directories are direct, safely named children of this directory and
may contain exactly those five files. The unit sweep inventories every child,
so an unvalidated candidate cannot silently land beside them.

All candidates start as `candidate/not-deployable`. The offline validator and
disposable PostgreSQL 17 replay are necessary checks, not promotion by
themselves.

Validate a candidate without connecting to a database:

```bash
npm run qa:baseline-candidate -- supabase/baseline-candidates/<candidate>
npm run qa:baseline-candidates
```

The validator checks the exact JSON contracts, candidate and forward-migration
hashes and completeness, normalized catalogue/ledger structure and digests,
path and symlink boundaries, PostgreSQL 17 identity, the positive
`public`/`arena` mutation scope, immediate-execution SQL, psql meta-command
escapes, migration-ledger references, sequence-state changes, common
host/outbound capabilities, and credential/connection identifiers.

Replay only through the candidate-directory entry point. The harness runs the
validator itself, re-reads and hashes every executable file into a private
staging directory, and derives the foundation/app/forward paths from the
manifest; callers cannot mix artifacts from different candidates.

```bash
ARENA_DISPOSABLE_BASELINE_REPLAY=1 \
PG17_BIN=/absolute/path/to/postgresql@17/bin \
bash scripts/maintenance/replay-baseline-candidate.pg17.sh \
  --candidate-dir supabase/baseline-candidates/<candidate>
```

The harness rejects database URLs and libpq host settings, requires one exact
PostgreSQL toolchain at 17.6 or newer, isolates HOME/libpq credential files,
starts PostgreSQL with `listen_addresses=''` on a short private Unix socket,
and applies each pre-scanned phase in its own fail-fast transaction. If a server
cannot be stopped, it preserves and reports the exact cluster/socket paths
instead of deleting a live data directory.

This static gate and local replay are designed to prevent accidental unsafe
execution. Foundation and forward files remain trusted, reviewed repository
inputs: the conservative body scan catches direct and common dynamic
host/outbound operations, but it cannot prove arbitrary constructed SQL safe
and is not a sandbox for hostile superuser-controlled input. The success
message is deliberately “dependency replay passed,” not promotion or production
equivalence.

## Capture and promotion boundary

A production-derived capture requires an explicit session/direct database URL,
the project-specific Supabase CA certificate, TLS `verify-full`, PostgreSQL 17
client tools, and a repeatable-read read-only snapshot. Capture code must not
load an implicit dotenv file, put credentials in argv or output, read business
rows, or update `supabase_migrations`.

The capture command is separately and exactly opted in. Provision the three
input variables through an approved secret-injection mechanism; do not place a
real URL in documentation or shell history.

```bash
export ARENA_BASELINE_SOURCE_DATABASE_URL       # dedicated source URL
export ARENA_BASELINE_SOURCE_CA_FILE            # absolute project CA path
export PG17_BIN                                 # one PostgreSQL 17.6+ bin directory

ARENA_CANONICAL_BASELINE_CAPTURE=1 \
node scripts/maintenance/capture-canonical-baseline.mjs \
  --output-dir /absolute/path/to/a-new-source-capture
```

The URL is accepted only for an official Supabase direct or session-pooler DNS
name on port 5432 and must contain one exact `sslmode=verify-full` option. The CA
must be a valid, currently usable CA certificate at a canonical absolute path
with no symlink component and owner-only permissions. The output parent must
likewise be a canonical, owner-owned `0700` directory (for example a private
child beneath `/private/tmp`, never macOS's `/tmp` alias or the shared
`/private/tmp` directory itself). The Node client additionally pins certificate
and hostname verification;
`pg_dump` receives credentials only in a minimal allowlisted child environment,
never argv. Ambient cloud tokens and dynamic-loader injection variables are not
passed to PostgreSQL tools.

The command opens `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, exports one
snapshot, reads fixed `pg_catalog` queries plus
`supabase_migrations.schema_migrations`, and keeps the exporting transaction
open until the schema-only `pg_dump --snapshot`, SQL safety validation, and
artifact writes finish. Ledger statement text is SHA-256 digested in memory and
is never written. The digest covers the canonical typed payload
`{"kind":"sql-statements","value":...}` so a historical `NULL` statement body
remains distinct from a recorded empty array. Locale-sensitive catalogue
ordering is replaced with deterministic JavaScript code-unit ordering, and
relevant session GUCs are pinned. The capture and candidate validator share
exact per-category row contracts rather than accepting arbitrary catalogue
objects.

Capture selects only application schemas `public` and `arena` and passes
`--exclude-extension=*`: installed extension names, versions, and schemas are
recorded in the catalogue, while reviewed extension creation belongs to the
disposable managed foundation. Publication DDL is likewise excluded from the
app dump and retained as catalogue evidence for later reconciliation. Security
labels and subscriptions are outside this V1 app-schema capture. These bounds
keep managed Supabase prerequisites outside app-schema SQL.

PostgreSQL 17 emits one `CREATE SCHEMA "public";` even though every fresh
PostgreSQL and Supabase target already provides that schema. Capture requires
that exact statement exactly once, replaces only that line with a fixed comment,
then re-runs SQL safety validation. It fails closed if the dump shape changes.
Publication evidence preserves all-table, relation, and schema memberships,
including partition-root mode, row filters, and selected columns. Type evidence
filters generated array/table-row types while retaining standalone composite
attributes and domain definitions/constraints.

Publishing never uses replacement-style directory rename. An exclusive
`mkdir` atomically claims the previously absent output path, an incomplete
marker keeps the visible directory invalid while the two already-complete staged
files are hard-linked without replacement, and removing that marker is the
commit point. Consumers must reject a directory containing the marker or any
artifact set other than exactly `app-schema.sql` and `source-catalog.json`.
This is a portable no-overwrite/readiness protocol, not a claim that the whole
directory is absent until commit. Both final files are owner-only. Filesystems
without hard-link support fail closed. Marker removal is the logical commit
point for process interruption; this V1 scaffold does not claim power-loss
durability because it does not fsync the artifacts and parent directory. The
completed directory is source evidence, not a candidate, manifest, or deployment
authority. Normal failures roll back,
disconnect, and remove capture-owned staging/claims before returning a generic
error without libpq/pg_dump stderr. The default hosted unit sweep exercises this
with fake clients and local child processes only; its default path never
connects to a database.

Every PostgreSQL child has a wall timeout. Timeout or direct CLI
`SIGINT`/`SIGTERM` sends `SIGTERM`, escalates to `SIGKILL` after a bounded grace
period, and waits for child close before the single-owner disconnect/cleanup
path proceeds. A signal before the final commit gate publishes nothing; a
successful marker removal after that gate is reported as committed success so
automation never receives an interrupted exit for published artifacts. If
cleanup itself fails, the command reports `CAPTURE_CLEANUP_FAILED` and does not
claim success; inspect the selected output parent for a private
`.arena-baseline-capture-*` directory or an incomplete claimed output before
retrying. Other database/tool errors are deliberately reduced to the generic
`CAPTURE_FAILED` code so remote error text cannot disclose credentials.

The optional local integration check starts an isolated Unix-socket-only PG17
cluster, executes all fixed catalogue queries, proves publication/composite/
domain semantics, exports a real snapshot, and validates the exact dump flags:

```bash
ARENA_REAL_BASELINE_CAPTURE_PG17_TEST=1 \
PG17_BIN=/absolute/path/to/postgresql-17.6-or-newer/bin \
npm run qa:baseline-capture
```

Promotion requires all of the following in a separately reviewed maintenance
wave:

1. Review the schema dump and every forward migration.
2. Replay managed foundation -> baseline -> forward manifest on two new,
   disposable PostgreSQL 17 Supabase scratch projects.
3. Prove normalized tables, columns, constraints, indexes, functions, views,
   triggers, RLS policies, ACL/default privileges, extensions, and publications
   are deterministic and match the approved V1 target.
4. Run PostgREST/RLS, generated-type, critical-RPC, and application read-only
   smoke checks.
5. Keep Preview replayability separate from production deployability. Any
   production migration still follows ADR-023 single-file review and exact
   postflight.

Do not run `supabase db push --include-all`, ledger-only `migration repair`, a
production restore, or an automatic migration-layout cutover from this
directory.
