import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260716101500_add_interaction_export_cursor_indexes.sql'
  ),
  'utf8'
)

const expectedIndexes = [
  ['idx_notifications_export_user_id_id', 'notifications'],
  ['idx_comment_likes_export_user_id_id', 'comment_likes'],
  ['idx_post_emoji_reactions_export_user_id_id', 'post_emoji_reactions'],
] as const

describe('interaction export cursor indexes migration', () => {
  it('builds one concurrent owner/id index for each interaction export dataset', () => {
    expect(migration.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(
      expectedIndexes.length
    )

    for (const [indexName, tableName] of expectedIndexes) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}\\s+` +
            `ON public\\.${tableName} \\(user_id, id\\);`
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

    for (const [indexName, tableName] of expectedIndexes) {
      expect(migration).toContain(`'${indexName}'`)
      expect(migration).toContain(`'public.${tableName}'::regclass`)
      expect(migration).toContain("ARRAY['user_id', 'id']::name[]")
    }
  })
})
