#!/usr/bin/env node

import { config } from 'dotenv'
import pg from 'pg'

config({ path: process.env.ENV_FILE || '.env.local', quiet: true })

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is required')
  process.exit(2)
}

const client = new pg.Client({ connectionString })

async function one(sql) {
  return (await client.query(sql)).rows[0]
}

try {
  await client.connect()
  await client.query('BEGIN READ ONLY')
  await client.query("SET LOCAL statement_timeout = '30s'")

  const inventory = await one(`
    SELECT
      count(*)::integer AS links,
      count(DISTINCT user_id)::integer AS users,
      pg_size_pretty(pg_total_relation_size('public.user_linked_traders')) AS total_size
    FROM public.user_linked_traders
  `)
  const primaryDrift = await one(`
    WITH per_user AS (
      SELECT
        user_id,
        count(*) FILTER (WHERE is_primary IS TRUE) AS primary_count
      FROM public.user_linked_traders
      GROUP BY user_id
    )
    SELECT
      count(*) FILTER (WHERE primary_count = 0)::integer AS zero_primary_users,
      count(*) FILTER (WHERE primary_count > 1)::integer AS multi_primary_users
    FROM per_user
  `)
  const missingProfiles = await one(`
    SELECT count(*)::integer AS count
    FROM (SELECT DISTINCT user_id FROM public.user_linked_traders) linked
    LEFT JOIN public.user_profiles profile ON profile.id = linked.user_id
    WHERE profile.id IS NULL
  `)
  const unverifiedLinks = await one(`
    SELECT count(*)::integer AS count
    FROM public.user_linked_traders linked
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.verified_traders verified
      WHERE verified.user_id = linked.user_id
        AND verified.trader_id = linked.trader_id
        AND verified.source = linked.source
    )
  `)
  const privileges = await one(`
    SELECT
      has_table_privilege('anon', 'public.user_linked_traders', 'INSERT') AS anon_insert,
      has_table_privilege('anon', 'public.user_linked_traders', 'UPDATE') AS anon_update,
      has_table_privilege('anon', 'public.user_linked_traders', 'DELETE') AS anon_delete,
      has_table_privilege('authenticated', 'public.user_linked_traders', 'INSERT') AS auth_insert,
      has_table_privilege('authenticated', 'public.user_linked_traders', 'UPDATE') AS auth_update,
      has_table_privilege('authenticated', 'public.user_linked_traders', 'DELETE') AS auth_delete
  `)
  const policies = (
    await client.query(`
      SELECT policyname, roles, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'user_linked_traders'
      ORDER BY policyname
    `)
  ).rows
  const targetIndex = (
    await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'user_linked_traders_one_primary_per_user'
    `)
  ).rows
  const targetMigration = (
    await client.query(`
      SELECT version
      FROM supabase_migrations.schema_migrations
      WHERE version = '20260715235000'
    `)
  ).rows

  await client.query('ROLLBACK')

  const failures = []
  for (const [privilege, granted] of Object.entries(privileges)) {
    if (granted) failures.push(`${privilege} must be revoked`)
  }
  if (missingProfiles.count > 0) failures.push('linked users without profiles must be repaired')
  if (unverifiedLinks.count > 0) failures.push('unverified linked rows must be audited')
  if (targetIndex.length > 0 && targetMigration.length === 0) {
    failures.push('target index exists without the target migration ledger entry')
  }

  console.log(
    JSON.stringify(
      {
        safe_to_apply: failures.length === 0,
        failures,
        inventory,
        primary_drift: primaryDrift,
        missing_profile_users: missingProfiles.count,
        links_without_verified_record: unverifiedLinks.count,
        privileges,
        policies,
        target_index: targetIndex,
        target_migration_applied: targetMigration.length === 1,
      },
      null,
      2
    )
  )
  if (failures.length > 0) process.exitCode = 1
} catch (error) {
  try {
    await client.query('ROLLBACK')
  } catch {
    // The connection may have failed before a transaction started.
  }
  console.error(
    JSON.stringify({
      error: error?.code || 'PREFLIGHT_FAILED',
      message: error instanceof Error ? error.message : 'Unknown preflight failure',
    })
  )
  process.exitCode = 2
} finally {
  await client.end().catch(() => undefined)
}
