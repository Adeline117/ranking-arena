#!/usr/bin/env node
/**
 * Apply trading platform migration (00015) to Supabase.
 * Usage: node scripts/verify/apply-migration.mjs
 *
 * Reads SQL from supabase/migrations/00015_trading_platform_mvp.sql
 * and executes it via Supabase's REST RPC endpoint.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function main() {
  console.log('Checking if migration is needed...');

  // Check if trader_snapshots_v2 exists
  const { error: checkErr } = await db.from('trader_snapshots_v2').select('id').limit(1);

  if (!checkErr) {
    console.log('✓ trader_snapshots_v2 already exists. Migration already applied.');

    // Also check other tables
    const checks = ['trader_profiles', 'trader_timeseries', 'refresh_jobs'];
    for (const table of checks) {
      const { error } = await db.from(table).select('id').limit(1);
      console.log(`  ${table}: ${error ? 'MISSING - ' + error.message : 'OK'}`);
    }
    return;
  }

  console.log('trader_snapshots_v2 not found. Applying migration...');
  console.log('');
  console.log('NOTE: Supabase REST API does not support raw SQL execution.');
  console.log('Please apply the migration manually:');
  console.log('');
  console.log('Option 1: Supabase Dashboard');
  console.log('  1. Go to https://supabase.com/dashboard/project/iknktzifjdyujdccyhsv/sql');
  console.log('  2. Paste contents of: supabase/migrations/00015_trading_platform_mvp.sql');
  console.log('  3. Click "Run"');
  console.log('');
  console.log('Option 2: CLI (if you have DATABASE_URL)');
  console.log('  psql "$DATABASE_URL" -f supabase/migrations/00015_trading_platform_mvp.sql');
  console.log('');
  console.log('Option 3: Supabase CLI');
  console.log('  supabase db push');
  console.log('');

  // Read and show the migration content for easy copy-paste
  const sqlPath = resolve(ROOT, 'supabase/migrations/00015_trading_platform_mvp.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  console.log('--- Migration SQL (copy-paste into SQL Editor) ---');
  console.log(sql);
}

main().catch(err => { console.error(err); process.exit(1); });
