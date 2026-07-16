import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716091500_add_security_export_cursor_indexes.sql'),
  'utf8'
)

const expected = [
  ['idx_login_sessions_export_user_id_id', 'login_sessions'],
  ['idx_api_keys_export_user_id_id', 'api_keys'],
  ['idx_user_passkeys_export_user_id_id', 'user_passkeys'],
  ['idx_push_subscriptions_export_user_id_id', 'push_subscriptions'],
  ['idx_backup_codes_export_user_id_id', 'backup_codes'],
  ['idx_account_recovery_tokens_export_user_id_id', 'account_recovery_tokens'],
] as const

describe('security export cursor indexes migration', () => {
  it('builds one concurrent user/id index for every security metadata dataset', () => {
    expect(migration.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(
      expected.length
    )
    for (const [indexName, tableName] of expected) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}\\s+` +
            `ON public\\.${tableName} \\(user_id, id\\);`
        )
      )
      expect(migration).toContain(`'public.${tableName}'::regclass`)
    }
  })

  it('bounds deployment waits and stays outside a transaction block', () => {
    expect(migration).toContain("SET lock_timeout = '5s';")
    expect(migration).toContain("SET statement_timeout = '30min';")
    expect(migration).toContain('RESET statement_timeout;')
    expect(migration).toContain('RESET lock_timeout;')
    expect(migration).not.toMatch(/(^|\n)\s*BEGIN\s*;/i)
    expect(migration).not.toMatch(/(^|\n)\s*COMMIT\s*;/i)
  })

  it('postflights exact, ready, valid two-key btrees', () => {
    expect(migration).toContain('index_metadata.indisvalid')
    expect(migration).toContain('index_metadata.indisready')
    expect(migration).toContain('index_metadata.indpred IS NULL')
    expect(migration).toContain('index_metadata.indexprs IS NULL')
    expect(migration).toContain('index_metadata.indnkeyatts = 2')
    expect(migration).toContain('index_metadata.indnatts = 2')
    expect(migration).toContain("access_method.amname = 'btree'")
    expect(migration).toContain("ARRAY['user_id', 'id']::name[]")
    for (const [indexName] of expected) expect(migration).toContain(`'${indexName}'`)
  })
})
