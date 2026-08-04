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
