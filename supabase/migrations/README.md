# Database Migrations

## Overview

This directory contains SQL migration files for the Supabase/PostgreSQL database. Migrations are applied in order based on their filename prefix.

## Naming Convention

```
YYYYMMDDHHMMSS_description.sql
```

- `YYYYMMDDHHMMSS` — 14-digit UTC timestamp, minute+second precision
- `description` — Short snake_case description of the change

Examples:
```
20260409150432_add_trader_alerts_table.sql
20260409161205_add_hot_score_index.sql
```

### Legacy format (pre-2026-04-10, do not use for new files)

Older files use `YYYYMMDD<letter>_description.sql` (e.g. `20260408h_foo.sql`).
This format is retained for existing files but **must not be used for new
migrations** — two agents independently guessing the next letter suffix for
the same day will collide and fail the pre-commit duplicate check. The
collision that forced this convention change was `20260408h_sharpe_cap_20.sql`
vs `20260408h2_sharpe_cap_20.sql` (see commit `5c8541143`).

New files sort AFTER legacy letter-suffix files as long as the date is
strictly greater than the latest legacy date.

## Creating a New Migration

**Always use the helper script** — it generates a collision-proof timestamped
filename and seeds the file with boilerplate:

```bash
scripts/new-migration.sh add_trader_stats_index
# → supabase/migrations/20260409161205_add_trader_stats_index.sql
```

The helper handles rare same-second collisions by retrying with +1s offsets
(up to 10 retries) and finally falls back to a random 4-digit suffix.

Then edit the generated file:

```sql
-- Migration: 20260409161205_add_trader_stats_index
-- Created: 2026-04-09T16:12:05Z
-- Description: What this migration does and why

-- Up
ALTER TABLE traders ADD COLUMN verified BOOLEAN DEFAULT FALSE;
CREATE INDEX idx_traders_verified ON traders(verified) WHERE verified = TRUE;
```

## Applying Migrations

### Via Supabase CLI (recommended):
```bash
supabase db push
```

### Via Supabase Dashboard:
1. Go to SQL Editor
2. Paste the migration SQL
3. Execute

### Via psql:
```bash
psql $DATABASE_URL -f supabase/migrations/NNNNN_description.sql
```

## Rules

1. **Always use `scripts/new-migration.sh`** to generate filenames — never write a raw filename
2. **Never modify an existing migration** that has been applied to staging/production
3. **Always test locally first** using `supabase db reset`
4. **One concern per migration** — don't mix unrelated changes
5. **Include rollback comments** for complex changes (as SQL comments)
6. **Pre-commit hook** (`.git/hooks/pre-commit`) blocks commits with duplicate
   version prefixes — if you see that error, you likely created a filename by
   hand instead of running the helper script

## Local Development

```bash
# Start local Supabase
supabase start

# Apply all migrations
supabase db reset

# Create a new migration from diff
supabase db diff -f my_change_name
```
