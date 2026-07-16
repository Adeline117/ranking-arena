import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716110000_add_domain_export_cursor_indexes.sql'),
  'utf8'
)

const expectedIndexes = [
  ['idx_group_members_export_user_id_group_id', 'group_members', 'user_id', 'group_id'],
  ['idx_group_subscriptions_export_user_id_id', 'group_subscriptions', 'user_id', 'id'],
  ['idx_group_applications_export_applicant_id_id', 'group_applications', 'applicant_id', 'id'],
  ['idx_trader_alerts_export_user_id_id', 'trader_alerts', 'user_id', 'id'],
  ['idx_user_collections_export_user_id_id', 'user_collections', 'user_id', 'id'],
  ['idx_collection_items_export_collection_id_id', 'collection_items', 'collection_id', 'id'],
] as const

describe('domain export cursor indexes migration', () => {
  it('builds one concurrent owner/cursor index for each domain dataset', () => {
    expect(migration.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(
      expectedIndexes.length
    )

    for (const [indexName, tableName, ownerColumn, cursorColumn] of expectedIndexes) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}\\s+` +
            `ON public\\.${tableName} \\(${ownerColumn}, ${cursorColumn}\\);`
        )
      )
    }
  })

  it('bounds deployment waits without wrapping concurrent builds in a transaction', () => {
    expect(migration).toContain("SET lock_timeout = '5s';")
    expect(migration).toContain("SET statement_timeout = '30min';")
    expect(migration).toContain('RESET statement_timeout;')
    expect(migration).toContain('RESET lock_timeout;')
    expect(migration).not.toMatch(/(^|\n)\s*BEGIN\s*;/i)
    expect(migration).not.toMatch(/(^|\n)\s*COMMIT\s*;/i)
  })

  it('fails closed on invalid or same-name indexes with a different definition', () => {
    expect(migration).toContain("index_namespace.nspname = 'public'")
    expect(migration).toContain('index_metadata.indrelid = v_table')
    expect(migration).toContain('index_metadata.indisvalid')
    expect(migration).toContain('index_metadata.indisready')
    expect(migration).toContain('NOT index_metadata.indisunique')
    expect(migration).toContain('NOT index_metadata.indisprimary')
    expect(migration).toContain('NOT index_metadata.indisexclusion')
    expect(migration).toContain('index_metadata.indpred IS NULL')
    expect(migration).toContain('index_metadata.indexprs IS NULL')
    expect(migration).toContain('index_metadata.indnkeyatts = 2')
    expect(migration).toContain('index_metadata.indnatts = 2')
    expect(migration).toContain("access_method.amname = 'btree'")
    expect(migration).toContain('pg_catalog.unnest(index_metadata.indoption)')
    expect(migration).toContain(') = v_columns')

    for (const [indexName, tableName, ownerColumn, cursorColumn] of expectedIndexes) {
      expect(migration).toContain(`'${indexName}'`)
      expect(migration).toContain(`'public.${tableName}'::regclass`)
      expect(migration).toContain(`ARRAY['${ownerColumn}', '${cursorColumn}']::name[]`)
    }
  })
})
