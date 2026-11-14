# Critical-tier backup (accounts, content, billing)

**What it is.** An encrypted dump of the data that cannot be rebuilt: the `auth`
schema and the `public` schema, with the rows of pipeline-derived tables left
out (their definitions are kept). Production is ~90 GB but this tier is on the
order of 100 MB, so it runs in seconds on any machine — including before a
release window when the full-database backup path is unavailable.

**What it is not.** A full disaster-recovery image. Restoring it gives you
users, identities, posts, groups, subscriptions and follows with empty market
tables (`tph_*`, `trader_equity_curve`, `lr_*`, …), to be refilled by the
ingest pipeline. The excluded tables are listed in
`DERIVED_TABLE_DATA_PATTERNS` in `scripts/maintenance/backup-critical-tier.mjs`.

## Take a backup

The passphrase must come from outside the repository. On this machine it is
kept in a file only the owner can read (the macOS Keychain refuses
non-interactive access, so it cannot be used from an agent or cron):

```bash
mkdir -p ~/.config/arena && chmod 700 ~/.config/arena
( umask 077; openssl rand -base64 48 > ~/.config/arena/critical-backup-passphrase )
```

**Copy that passphrase into a password manager.** A backup whose passphrase is
lost cannot be recovered, and a passphrase stored only next to the backups
protects nothing if the disk is lost.

Then, from the repository:

```bash
BACKUP_PASSPHRASE="$(cat ~/.config/arena/critical-backup-passphrase)" \
PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
DATABASE_URL="<session-mode URL, port 5432>" \
npm run backup:critical -- --out ~/arena-backups/critical
```

`pg_dump` needs a **session** connection. The app's `DATABASE_URL` points at
the transaction pooler (port 6543), which cannot run a dump; use the same
pooler host on port 5432 (session mode) or the direct database host.

The command prints the file path, size, SHA-256 and the number of tables with
data. It only reports success after decrypting the whole file again and
confirming every required relation (`REQUIRED_TABLE_DATA`) is present. Output
files are mode `0600`; keep the directory outside the repository.

First production run (2026-11-14): 9.4 MB, 195 tables with data, ~1 minute.

## Check or restore a backup

```bash
# Re-verify an existing file
BACKUP_PASSPHRASE=… node scripts/maintenance/backup-critical-tier.mjs verify <file>

# Decrypt to a pg_dump custom-format archive, then restore into a SCRATCH database
BACKUP_PASSPHRASE=… node scripts/maintenance/backup-critical-tier.mjs decrypt <file> critical.dump
pg_restore --no-owner -d <scratch-database-url> critical.dump
```

A plain PostgreSQL scratch database needs the Supabase scaffolding the dump
refers to before `pg_restore` (a Supabase scratch project already has it):

```sql
DROP SCHEMA public;            -- the dump recreates it
CREATE SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE EXTENSION citext SCHEMA extensions;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
```

Without the `extensions` schema, tables whose defaults call its functions
(comments, notifications, likes, …) fail to create. With it, the 2026-11-14
drill restored all 186 `public` tables and matched production row counts
exactly for users, profiles, posts, comments, notifications, groups, members
and subscriptions; the only remaining errors were a missing `postgres` role
and one reference into the excluded `arena` schema.

Never restore over production directly: restore into a scratch project,
inspect, and copy the specific rows you need.

## When to run it

- Before applying any batch of migrations or opening a release window.
- Before any manual data repair on user tables.

`npm run qa:backup-critical` runs the contract tests, including an end-to-end
PostgreSQL 17 backup → decrypt → restore drill when the binaries are installed.
