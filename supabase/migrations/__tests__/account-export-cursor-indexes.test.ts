import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716090000_add_account_export_cursor_indexes.sql'),
  'utf8'
)

const expectedIndexes = [
  ['idx_posts_export_author_id_id', 'posts', 'author_id'],
  ['idx_comments_export_user_id_id', 'comments', 'user_id'],
  ['idx_user_follows_export_follower_id_id', 'user_follows', 'follower_id'],
  ['idx_user_follows_export_following_id_id', 'user_follows', 'following_id'],
  ['idx_tips_export_from_user_id_id', 'tips', 'from_user_id'],
  ['idx_tips_export_to_user_id_id', 'tips', 'to_user_id'],
] as const

describe('account export cursor indexes migration', () => {
  it('builds exactly one concurrent owner/id index for every exported dataset', () => {
    const creates = migration.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g) ?? []
    expect(creates).toHaveLength(expectedIndexes.length)

    for (const [indexName, tableName, ownerColumn] of expectedIndexes) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}\\s+` +
            `ON public\\.${tableName} \\(${ownerColumn}, id\\);`
        )
      )
    }
  })

  it('bounds deployment lock waits without wrapping concurrent builds in a transaction', () => {
    expect(migration).toContain("SET lock_timeout = '5s';")
    expect(migration).toContain("SET statement_timeout = '30min';")
    expect(migration).toContain('RESET statement_timeout;')
    expect(migration).toContain('RESET lock_timeout;')
    expect(migration).not.toMatch(/(^|\n)\s*BEGIN\s*;/i)
    expect(migration).not.toMatch(/(^|\n)\s*COMMIT\s*;/i)
  })

  it('fails closed on invalid or same-name indexes with a different definition', () => {
    expect(migration).toContain('index_metadata.indisvalid')
    expect(migration).toContain('index_metadata.indisready')
    expect(migration).toContain('index_metadata.indpred IS NULL')
    expect(migration).toContain('index_metadata.indexprs IS NULL')
    expect(migration).toContain('index_metadata.indnkeyatts = 2')
    expect(migration).toContain('index_metadata.indnatts = 2')
    expect(migration).toContain("access_method.amname = 'btree'")
    expect(migration).toContain(') = v_columns')

    for (const [indexName, tableName, ownerColumn] of expectedIndexes) {
      expect(migration).toContain(`'${indexName}'`)
      expect(migration).toContain(`'public.${tableName}'::regclass`)
      expect(migration).toContain(`ARRAY['${ownerColumn}', 'id']::name[]`)
    }
  })
})
