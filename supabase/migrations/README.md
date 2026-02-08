# Database Migrations

## Overview

This directory contains SQL migration files for the Supabase/PostgreSQL database. Migrations are applied in order based on their filename prefix.

## Naming Convention

```
NNNNN_description.sql
```

- `NNNNN` — 5-digit sequential version number (e.g., `00001`)
- `description` — Short snake_case description of the change

Examples:
```
00001_initial_schema.sql
00002_add_trader_alerts_table.sql
00003_add_hot_score_index.sql
```

## Creating a New Migration

1. Find the next version number:
   ```bash
   ls supabase/migrations/*.sql | tail -1
   ```

2. Create the migration file:
   ```bash
   touch supabase/migrations/NNNNN_description.sql
   ```

3. Write your SQL. Always include both the change and a comment:
   ```sql
   -- Migration: NNNNN_description
   -- Description: What this migration does
   -- Author: Your Name
   -- Date: YYYY-MM-DD

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

1. **Never modify an existing migration** that has been applied to staging/production
2. **Always test locally first** using `supabase db reset`
3. **One concern per migration** — don't mix unrelated changes
4. **Include rollback comments** for complex changes (as SQL comments)
5. **CI checks** for duplicate version numbers (see `.github/workflows/ci.yml`)

## Local Development

```bash
# Start local Supabase
supabase start

# Apply all migrations
supabase db reset

# Create a new migration from diff
supabase db diff -f my_change_name
```
