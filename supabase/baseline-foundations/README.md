# Disposable Supabase foundation fixtures

This directory is reserved for reviewed PostgreSQL 17 SQL fixtures that model
only the managed Supabase prerequisites needed by a canonical baseline replay.
It is not a migration directory, a production dump, or a deployment channel.

Every fixture is immutable for a candidate: `manifest.json` records its
repository-relative path and SHA-256 under the
`arena.disposable-supabase-foundation@1` contract with status
`fixture/not-production`. The replay harness applies the pinned fixture first,
then compares the exact before/after catalogue delta for declared roles,
schemas, extensions, function signatures, relations, and types. It also proves
that the fixture did not pre-create the `arena` schema or application-owned
relations, routines, or types in `public`/`arena`.

The relation witness includes stable user-facing table, partition, view,
materialized-view, sequence, and foreign-table names outside system schemas.
The type witness excludes generated array and table-row types while retaining
standalone declared types. This avoids binding a candidate to transient TOAST
OIDs or other automatically generated catalogue names.

A fixture must contain no credentials, connection identifiers, psql
meta-commands, executable `DO`, transaction control, server-file `COPY`,
host/outbound capability, or non-atomic `CONCURRENTLY` operation. Foundation
SQL is additive: it may only use the narrow declarative `CREATE` allowlist and
cannot replace objects, alter owners, or grant/revoke ACLs on the initialized
cluster. It must never be applied to an existing or remote database. Passing
the local fixture check does not substitute for replay on two disposable managed
Supabase PostgreSQL 17 projects.
