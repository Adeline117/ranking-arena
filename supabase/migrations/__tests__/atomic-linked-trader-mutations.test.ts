import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260715235000_atomic_linked_trader_mutations.sql'),
  'utf8'
)

describe('atomic linked trader mutations migration', () => {
  it('repairs drift and enforces at most one primary row per user', () => {
    expect(migration).toMatch(/row_number\(\) OVER \([\s\S]*PARTITION BY user_id/)
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS user_linked_traders_one_primary_per_user[\s\S]*WHERE is_primary IS TRUE/
    )
  })

  it('locks the user and proves target ownership before clearing another primary', () => {
    const primaryFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.set_primary_linked_trader'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.unlink_linked_trader')
    )
    expect(primaryFunction).toMatch(/pg_advisory_xact_lock/)
    expect(primaryFunction.indexOf('linked.id = p_link_id')).toBeLessThan(
      primaryFunction.indexOf('SET is_primary = false')
    )
    expect(primaryFunction).toMatch(/linked\.user_id = p_user_id[\s\S]*FOR UPDATE/)
    expect(primaryFunction).toMatch(/UPDATE public\.user_profiles[\s\S]*verified_trader_id/)
  })

  it('unlinks, promotes, and updates the profile projection in one function', () => {
    const unlinkFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.unlink_linked_trader'),
      migration.indexOf('REVOKE ALL ON FUNCTION public.set_primary_linked_trader')
    )
    expect(unlinkFunction).toMatch(/DELETE FROM public\.user_linked_traders/)
    expect(unlinkFunction).toMatch(/SET is_primary = true/)
    expect(unlinkFunction).toMatch(/linked_trader_count = v_remaining_count/)
    expect(unlinkFunction).toMatch(/is_verified_trader = false[\s\S]*linked_trader_count = 0/)
  })

  it('exposes both mutation functions only to the service role', () => {
    for (const functionName of ['set_primary_linked_trader', 'unlink_linked_trader']) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\(uuid, uuid\\)[\\s\\S]*FROM PUBLIC, anon, authenticated`
        )
      )
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${functionName}(uuid, uuid) TO service_role`
      )
    }
  })
})
