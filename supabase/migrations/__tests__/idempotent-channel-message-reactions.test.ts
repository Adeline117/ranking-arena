import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260729180500_idempotent_channel_message_reactions.sql'
  ),
  'utf8'
)

describe('idempotent channel-message reaction authority', () => {
  it('is bounded, replayable, and owns a private durable ledger', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('CREATE TABLE public.channel_message_reaction_operations')
    expect(migration).toContain(
      'ALTER TABLE public.channel_message_reaction_operations ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON TABLE public\.channel_message_reaction_operations[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('serializes operation replay before delegating one transactional toggle', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.toggle_channel_message_reaction_idempotent\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    const operationLock = body!.indexOf("'channel-message-reaction-operation:'")
    const replayRead = body!.indexOf('FROM public.channel_message_reaction_operations')
    const baseToggle = body!.indexOf('public.toggle_channel_message_reaction_atomic(')
    const ledgerInsert = body!.indexOf('INSERT INTO public.channel_message_reaction_operations')

    expect(operationLock).toBeGreaterThan(0)
    expect(operationLock).toBeLessThan(replayRead)
    expect(replayRead).toBeLessThan(baseToggle)
    expect(baseToggle).toBeLessThan(ledgerInsert)
    expect(body).toContain("'reason', 'OPERATION_CONFLICT'")
    expect(body).toContain("'applied', false")
    expect(body).toContain("'applied', true")
  })

  it('retires the non-idempotent external RPC and publishes one service-only boundary', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.toggle_channel_message_reaction_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.toggle_channel_message_reaction_idempotent\([\s\S]*TO service_role/
    )
    expect(migration).toContain('legacy channel-reaction RPC remained externally executable')
    expect(migration).toContain('idempotent-channel-message-reaction:v1:')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })
})
