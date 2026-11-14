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

The passphrase lives in the macOS Keychain, never in a file or shell history.
Create it once:

```bash
security add-generic-password -s arena-critical-backup -a arena \
  -l "Arena critical-tier backup passphrase" -w "$(openssl rand -base64 48)"
```

Then, from the repository (uses `DATABASE_URL` from the environment; use the
direct/session connection on port 5432, not the transaction pooler):

```bash
BACKUP_PASSPHRASE="$(security find-generic-password -s arena-critical-backup -a arena -w)" \
PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
npm run backup:critical -- --out ~/arena-backups/critical
```

The command prints the file path, size, SHA-256 and the number of tables with
data. It only reports success after decrypting the file again and confirming
every required relation (`REQUIRED_TABLE_DATA`) is present. Output files are
mode `0600`; keep the directory outside the repository.

**Keep a second copy of the passphrase** (password manager). A backup whose
passphrase is lost cannot be recovered.

## Check or restore a backup

```bash
# Re-verify an existing file
BACKUP_PASSPHRASE=… node scripts/maintenance/backup-critical-tier.mjs verify <file>

# Decrypt to a pg_dump custom-format archive, then restore into a SCRATCH database
BACKUP_PASSPHRASE=… node scripts/maintenance/backup-critical-tier.mjs decrypt <file> critical.dump
pg_restore --no-owner -d <scratch-database-url> critical.dump
```

Never restore over production directly: restore into a scratch project,
inspect, and copy the specific rows you need.

## When to run it

- Before applying any batch of migrations or opening a release window.
- Before any manual data repair on user tables.

`npm run qa:backup-critical` runs the contract tests, including an end-to-end
PostgreSQL 17 backup → decrypt → restore drill when the binaries are installed.
