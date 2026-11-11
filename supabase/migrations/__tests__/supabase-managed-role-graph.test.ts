// Source contract for the Supabase-managed role-edge exclusion carried by the
// forward replacements of the 2026-08-17 role-graph guards. Runtime behaviour
// is proven by supabase-managed-role-graph.pg17.sh
// (npm run qa:supabase-managed-graph-pg17); this pins the exact text so the
// exclusion cannot quietly widen and the originals stay untouched.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationDir = join(process.cwd(), 'supabase/migrations')
const read = (name: string): string => readFileSync(join(migrationDir, name), 'utf8')

const REPLACEMENTS: ReadonlyArray<readonly [original: string, replacement: string]> = [
  [
    '20260817020000_rank_history_service_only_acl.sql',
    '20261111132444_rank_history_service_only_acl_hosted_role_graph.sql',
  ],
  [
    '20260817030000_trader_activities_publication_fence.sql',
    '20261111132445_trader_activities_publication_fence_hosted_role_graph.sql',
  ],
  [
    '20260817040000_notification_ranking_change_reader_fence.sql',
    '20261111132446_notification_ranking_change_reader_fence_hosted_role_graph.sql',
  ],
  [
    '20260817050000_arena_bot_legacy_publication_isolation.sql',
    '20261111132447_arena_bot_legacy_publication_isolation_hosted_role_graph.sql',
  ],
  [
    '20260817060000_trader_series_publication_isolation.sql',
    '20261111132448_trader_series_publication_isolation_hosted_role_graph.sql',
  ],
  [
    '20260817061000_legacy_raw_metric_publication_isolation.sql',
    '20261111132450_legacy_raw_metric_publication_isolation_hosted_role_graph.sql',
  ],
]

const MANAGED_EDGES = [
  // cli_login_postgres -> postgres, SET only
  /membership\.roleid = pg_catalog\.to_regrole\('postgres'\)\s+AND membership\.member IS NOT DISTINCT FROM pg_catalog\.to_regrole\('cli_login_postgres'\)\s+AND NOT membership\.admin_option\s+AND NOT membership\.inherit_option\s+AND membership\.set_option/,
  // supabase_storage_admin -> authenticator, SET only
  /membership\.roleid IS NOT DISTINCT FROM pg_catalog\.to_regrole\('authenticator'\)\s+AND membership\.member IS NOT DISTINCT FROM pg_catalog\.to_regrole\('supabase_storage_admin'\)\s+AND NOT membership\.admin_option\s+AND NOT membership\.inherit_option\s+AND membership\.set_option/,
  // postgres -> authenticator (trusted owner)
  /membership\.roleid IS NOT DISTINCT FROM pg_catalog\.to_regrole\('authenticator'\)\s+AND membership\.member = pg_catalog\.to_regrole\('postgres'\)\s+\)/,
]

const PREAMBLE_START = '-- Supabase platform-managed role edges'
const PREAMBLE_END = '$supabase_managed_role_edges$;'

const preambleOf = (migration: string): string =>
  migration.slice(migration.indexOf(PREAMBLE_START), migration.indexOf(PREAMBLE_END))

const preambleFree = (migration: string): string =>
  migration.slice(0, migration.indexOf(PREAMBLE_START)) +
  migration.slice(migration.indexOf(PREAMBLE_END))

describe('Supabase-managed role-graph replacements', () => {
  const firstPreamble = preambleOf(read(REPLACEMENTS[0][1]))

  it.each(REPLACEMENTS)('%s is replaced by a later forward migration', (original, replacement) => {
    expect(
      replacement > '20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql'
    ).toBe(true)
    // The immutable original keeps its guards and never learns the exclusion.
    const originalSql = read(original)
    expect(originalSql).not.toContain('arena_guard_auth_members')
    expect(originalSql).not.toMatch(/cli_login_postgres|supabase_storage_admin/)

    const migration = read(replacement)
    expect(migration.startsWith(`-- Forward replacement for ${original}`)).toBe(true)

    // Apart from the header, the shared preamble, and the graph table name,
    // the body is the original verbatim.
    const body = preambleFree(migration.slice(migration.indexOf('\n--\n') + 4)).replace(
      /pg_temp\.arena_guard_auth_members/g,
      'pg_catalog.pg_auth_members'
    )
    const originalWithAnchor =
      originalSql.slice(0, originalSql.indexOf('DO $preflight$')) +
      PREAMBLE_END +
      originalSql.slice(originalSql.indexOf('DO $preflight$'))
    expect(body.replace(PREAMBLE_END + '\n\n', PREAMBLE_END)).toBe(originalWithAnchor)
  })

  it.each(REPLACEMENTS)(
    '%s replacement excludes only the managed edges and fails closed',
    (_original, replacement) => {
      const migration = read(replacement)
      const start = migration.indexOf(PREAMBLE_START)
      const end = migration.indexOf(PREAMBLE_END)
      expect(start).toBeGreaterThan(migration.indexOf('BEGIN;'))
      expect(end).toBeGreaterThan(start)
      expect(end).toBeLessThan(migration.indexOf('DO $preflight$'))

      const preamble = preambleOf(migration)
      expect(preamble).toBe(firstPreamble)
      expect(preamble).toContain(
        'CREATE TEMPORARY TABLE arena_guard_auth_members ON COMMIT DROP AS'
      )
      for (const edge of MANAGED_EDGES) {
        expect(preamble).toMatch(edge)
      }
      // Exactly three exempted edges: one OR-joined clause after the first.
      expect(preamble.match(/^\s{2}OR \(/gm)).toHaveLength(2)
      expect(preamble).toContain(
        "'Supabase-managed login roles must not be enterable or privileged'"
      )

      // Guards read only the filtered graph; the managed names live only in
      // the preamble.
      const rest = preambleFree(migration)
      expect(rest).not.toContain('pg_catalog.pg_auth_members')
      expect(rest.slice(rest.indexOf('BEGIN;'))).not.toMatch(
        /cli_login_postgres|supabase_storage_admin/
      )
      expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    }
  )
})
