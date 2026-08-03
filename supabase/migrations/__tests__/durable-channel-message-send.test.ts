import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729182000_durable_channel_message_send.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('durable channel-message send authority', () => {
  it('is bounded, replayable, and owns a private durable ledger', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('CREATE TABLE public.channel_message_send_operations')
    expect(migration).toContain(
      'ALTER TABLE public.channel_message_send_operations ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON TABLE public\.channel_message_send_operations[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fingerprints the complete scoped intent before one transactional send', () => {
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.send_channel_message_idempotent\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(body).toBeDefined()

    expect(body).toMatch(
      /jsonb_build_array\([\s\S]*'channel-message-send:v1',[\s\S]*p_sender_id,[\s\S]*p_channel_id,[\s\S]*p_content,[\s\S]*p_media_url,[\s\S]*p_media_type,[\s\S]*p_media_name,[\s\S]*p_reply_to_id/
    )
    const operationLock = body!.indexOf("'channel-message-send-operation:'")
    const replayRead = body!.indexOf('FROM public.channel_message_send_operations')
    const baseSend = body!.indexOf('public.send_channel_message_atomic(')
    const ledgerInsert = body!.indexOf('INSERT INTO public.channel_message_send_operations')

    expect(operationLock).toBeGreaterThan(0)
    expect(operationLock).toBeLessThan(replayRead)
    expect(replayRead).toBeLessThan(baseSend)
    expect(baseSend).toBeLessThan(ledgerInsert)
    expect(body).toContain("'reason', 'OPERATION_CONFLICT'")
    expect(body).toContain("'applied', false")
    expect(body).toContain("'applied', true")
  })

  it('retires the non-idempotent RPC and exposes one service-only boundary', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES[\s\S]*ON FUNCTION public\.send_channel_message_atomic\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE[\s\S]*ON FUNCTION public\.send_channel_message_idempotent\([\s\S]*TO service_role/
    )
    expect(migration).toContain('legacy channel-message send RPC remained externally executable')
    expect(migration).toContain('durable-channel-message-send:v1:')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(databaseTypes).toContain('channel_message_send_operations: {')
    expect(databaseTypes).toContain('send_channel_message_idempotent: {')
  })
})
