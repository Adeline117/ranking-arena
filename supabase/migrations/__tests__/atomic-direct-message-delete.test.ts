import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260716114200_atomic_direct_message_delete.sql'
)
const migration = readFileSync(migrationPath, 'utf8')

describe('atomic direct-message delete migration', () => {
  it('is a bounded, transactional, SQL-first boundary with explicit rollout order', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, public, pg_temp')
    expect(migration).toContain('pg_try_advisory_xact_lock')
    expect(migration).toContain('deploy 20260716112100 and')
    expect(migration).toContain('20260716114000 first')
    expect(migration).toContain('switch the DELETE')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('fails closed on the exact prior DM schema, functions, ACLs, and triggers', () => {
    expect(migration).toContain('canonical 20260716112100 check_dm_permission contract is required')
    expect(migration).toContain(
      'canonical 20260716114000 send_direct_message_atomic contract is required'
    )
    expect(migration).toContain('20260716114000 trigger-function contracts are required')
    expect(migration).toContain("'search_path=pg_catalog, pg_temp'")
    expect(migration).toContain("'lock_timeout=5s'")
    expect(migration).toContain('send_direct_message_atomic has duplicate or missing overloads')
    expect(migration).toContain('atomic direct-message delete boundary is partial or overloaded')
    expect(migration).toContain('insert side-effect triggers are not exactly once')
    expect(migration).toContain('direct-message pair trigger column contract drift detected')
    expect(migration).toContain(
      'direct_messages.conversation_id ON DELETE CASCADE FK contract drift detected'
    )
    expect(migration).toContain(
      'immediate nondeferrable ordered conversation-pair contract is required'
    )
    expect(migration).toContain('index_metadata.indimmediate')
    expect(migration).toContain('NOT constraint_row.condeferrable')
    expect(migration).toContain('browser read ACL contract drift detected')
    expect(migration).toContain('service table ACL contract drift detected')
    expect(migration).toContain("relation.relpersistence = 'p'")
    expect(migration).toContain("relation.relkind = 'r'")
    expect(migration).toContain('NOT relation.relispartition')
    expect(migration).toContain('pg_catalog.pg_inherits')
    expect(migration).toContain('pg_catalog.pg_rewrite')
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('LOCK TABLE public.conversations')
    )
  })

  it('publishes one service-only fixed-path RPC with explicit actor ownership', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.delete_direct_message_atomic\([\s\S]*p_message_id uuid,[\s\S]*p_actor_id uuid[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp[\s\S]*SET lock_timeout = '5s'/
    )
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain('v_sender_id <> p_actor_id')
    expect(migration).toContain("'reason', 'FORBIDDEN'")
    expect(migration).toContain("'reason', 'NOT_FOUND'")
    expect(migration).toMatch(
      /GRANT EXECUTE\s+ON FUNCTION public\.delete_direct_message_atomic\(uuid, uuid\)\s+TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_direct_message_atomic\(uuid, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
  })

  it('serializes against sends and legacy deletes on the same unordered-pair key', () => {
    expect(migration).toContain("'direct-message:pair:' || v_pair")
    expect(migration).toMatch(
      /CREATE TRIGGER trg_serialize_dm_message_pair[\s\S]*BEFORE INSERT OR DELETE OR UPDATE OF sender_id, receiver_id, deleted_at[\s\S]*EXECUTE FUNCTION public\.serialize_direct_message_pair_edge\(\)/
    )
    expect(migration).toContain(
      'direct-message pair serializer does not cover deleted_at exactly once'
    )
    expect(migration).toContain('direct-message pair or conversation changed; retry delete')
    expect(migration).toContain('pg_try_advisory_xact_lock')
    expect(migration).toContain('The parent conversation cascade owns this deletion boundary')
  })

  it('makes sent identity and payload immutable while allowing only message state', () => {
    const guardBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.guard_direct_message_immutable_fields\(\)[\s\S]*?\n\$function\$;/
    )?.[0]
    expect(guardBody).toBeDefined()
    expect(guardBody).toContain('SECURITY DEFINER')
    expect(guardBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(guardBody).toContain("SET lock_timeout = '5s'")
    expect(guardBody).toContain('pg_catalog.to_jsonb(NEW)')
    expect(guardBody).toContain('pg_catalog.to_jsonb(OLD)')
    expect(guardBody).toContain("ARRAY['read', 'read_at', 'deleted_at']::text[]")
    expect(guardBody).toContain('OLD.reply_to_id IS NOT NULL')
    expect(guardBody).toContain('NEW.reply_to_id IS NULL')
    expect(guardBody).toContain('pg_catalog.pg_trigger_depth() > 1')
    expect(guardBody).toContain('WHERE parent_message.id = OLD.reply_to_id')
    expect(guardBody).toContain('identity and payload are immutable after send')
    expect(guardBody).toContain('OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL')
    expect(guardBody).toContain('direct-message soft deletion is irreversible')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_guard_dm_immutable_fields[\s\S]*BEFORE UPDATE[\s\S]*FOR EACH ROW[\s\S]*EXECUTE FUNCTION public\.guard_direct_message_immutable_fields\(\)/
    )
    expect(migration).toContain(
      'direct_messages.updated_at requires an explicit mutability decision'
    )
    expect(migration).toContain(
      'direct_messages.reply_to_id ON DELETE SET NULL FK contract drift detected'
    )
    expect(migration).toContain('direct-message immutable-field guard postflight failed')
  })

  it('validates message, conversation, canonical pair, and sender after locking', () => {
    const rpcBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.delete_direct_message_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(rpcBody).toBeDefined()
    const pairLock = rpcBody?.indexOf("'direct-message:pair:' || v_pair") ?? -1
    const conversationLock =
      rpcBody?.indexOf(
        'FROM public.conversations AS conversation\n  WHERE conversation.id = v_initial_conversation_id\n  FOR UPDATE'
      ) ?? -1
    const messageLock =
      rpcBody?.indexOf(
        'FROM public.direct_messages AS message_row\n  WHERE message_row.id = p_message_id\n  FOR UPDATE'
      ) ?? -1
    expect(pairLock).toBeGreaterThanOrEqual(0)
    expect(conversationLock).toBeGreaterThan(pairLock)
    expect(messageLock).toBeGreaterThan(conversationLock)
    expect(rpcBody).toContain('v_user1_id <> LEAST(v_sender_id, v_receiver_id)')
    expect(rpcBody).toContain('v_user2_id <> GREATEST(v_sender_id, v_receiver_id)')
    expect(rpcBody).toContain('direct message is outside its canonical conversation pair')
  })

  it('locks reply sends in pair, conversation, message order', () => {
    const sendBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.send_direct_message_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(sendBody).toBeDefined()
    const pairLock = sendBody?.indexOf("'direct-message:pair:' || v_pair") ?? -1
    const conversationLock =
      sendBody?.indexOf(
        'FROM public.conversations AS conversation\n    WHERE conversation.user1_id = v_user1_id'
      ) ?? -1
    const replyLock =
      sendBody?.indexOf(
        'FROM public.direct_messages AS parent_message\n    WHERE parent_message.id = p_reply_to_id'
      ) ?? -1
    expect(pairLock).toBeGreaterThanOrEqual(0)
    expect(conversationLock).toBeGreaterThan(pairLock)
    expect(replyLock).toBeGreaterThan(conversationLock)
  })

  it('is idempotent and lets the trigger own exactly one atomic recalculation', () => {
    const rpcBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.delete_direct_message_atomic\([\s\S]*?\n\$function\$;/
    )?.[0]
    expect(rpcBody).toContain('IF v_existing_deleted_at IS NOT NULL')
    expect(rpcBody).toContain("'already_deleted', true")
    expect(rpcBody).toContain('UPDATE public.direct_messages AS message_row')
    expect(rpcBody).not.toContain('public.recalculate_direct_message_conversation_summary(')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_recalculate_dm_summary_after_delete[\s\S]*AFTER DELETE OR UPDATE OF deleted_at[\s\S]*FOR EACH ROW/
    )
    expect(migration).toContain('direct-message delete summary trigger is not exactly once')
  })

  it('recomputes from the newest live message with a non-sensitive empty fallback', () => {
    expect(migration.match(/created_at DESC NULLS LAST/g)?.length).toBeGreaterThanOrEqual(3)
    expect(migration.match(/message_row\.id DESC/g)?.length).toBeGreaterThanOrEqual(3)
    expect(migration).toContain('message_row.deleted_at IS NULL')
    expect(migration).toContain("'1970-01-01 00:00:00+00'::timestamptz")
    expect(migration).toContain('Unix epoch is the non-sensitive fallback')
    expect(migration).toContain('pg_catalog.left(latest_message.content, 100)')
    expect(migration).toContain('One-time calibration')
    expect(migration).toContain('neither deletes nor exposes a message')
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_direct_messages_live_conversation_latest[\s\S]*conversation_id,[\s\S]*created_at DESC NULLS LAST,[\s\S]*id DESC[\s\S]*WHERE deleted_at IS NULL/
    )
    expect(migration).toContain('direct-message live-summary index postflight failed')
  })

  it('covers legacy soft/hard delete without recursion and handles conversation cascades', () => {
    const triggerBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.maintain_direct_message_delete_summary\(\)[\s\S]*?\n\$function\$;/
    )?.[0]
    expect(triggerBody).toBeDefined()
    expect(triggerBody).toContain("TG_OP NOT IN ('UPDATE', 'DELETE')")
    expect(triggerBody).toContain('OLD.conversation_id')
    expect(triggerBody).toContain('public.recalculate_direct_message_conversation_summary(')
    expect(triggerBody).toContain('FOR UPDATE NOWAIT')
    expect(triggerBody).toContain('retry message delete')
    expect(triggerBody).not.toContain('UPDATE public.direct_messages')
    expect(migration).toContain('A conversation cascade may remove its messages')
    expect(migration).toContain('exact ON DELETE CASCADE FK')
    expect(migration).toContain('retry message write')
  })

  it('proves every direct-message trigger has an exact unconditional catalog shape', () => {
    expect(migration.match(/trigger_row\.tgqual IS NULL/g)?.length).toBeGreaterThanOrEqual(12)
    expect(migration).toContain('direct_messages exact user-trigger catalog drift detected')
    expect(migration).toContain('direct_messages six-trigger exact catalog postflight failed')
    expect(migration).toContain('pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 8')
    for (const attribute of [
      'v_conversation_id_attnum',
      'v_sender_attnum',
      'v_receiver_attnum',
      'v_content_attnum',
      'v_media_url_attnum',
      'v_media_type_attnum',
      'v_media_name_attnum',
      'v_reply_attnum',
    ]) {
      expect(migration).toContain(attribute)
    }
  })

  it('requires one complete FK authority per protected edge', () => {
    expect(migration.match(/v_reply_attnum = ANY\(constraint_row\.conkey\)/g)?.length).toBe(2)
    expect(
      migration.match(/constraint_row\.confrelid = 'public\.direct_messages'::regclass/g)?.length
    ).toBeGreaterThanOrEqual(4)
    expect(
      migration.match(/v_conversation_id_attnum = ANY\(constraint_row\.conkey\)/g)?.length
    ).toBe(2)
    expect(
      migration.match(/constraint_row\.confrelid = 'public\.conversations'::regclass/g)?.length
    ).toBeGreaterThanOrEqual(4)
    expect(migration).toContain('direct_messages.reply_to_id FK postflight failed')
    expect(migration).toContain('direct_messages.conversation_id FK postflight failed')
  })

  it('converges behavior-bearing dependencies to exact canonical source bodies', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.check_dm_permission(')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.create_message_notification()')
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.validate_direct_message_integrity()'
    )
    expect(migration).toContain('canonical direct-message dependency definitions did not converge')
    for (const sourceHash of [
      '1bc16d1d61dc83b45e9fe4d7796949c1',
      '8cede0f9d7aa6ec34e9212e69e4311c6',
      '9a0170f32101b7994e983a2b43dd52c7',
    ]) {
      expect(migration).toContain(sourceHash)
    }
  })

  it('uses one unordered immediate conversation-pair conflict authority', () => {
    expect(migration.match(/attribute\.attname ORDER BY attribute\.attname/g)?.length).toBe(4)
    expect(migration.match(/constraint_row\.contype IN \('u', 'x'\)/g)?.length).toBe(2)
    expect(migration.match(/index_metadata\.indisexclusion/g)?.length).toBeGreaterThanOrEqual(4)
    expect(migration).toContain('index_metadata.indimmediate')
  })

  it('reconstructs and exactly postflights the complete RLS read boundary', () => {
    expect(migration).toContain('DO $converge_message_policies$')
    expect(migration).toContain('CREATE POLICY "Authenticated participants read conversations"')
    expect(migration).toContain('CREATE POLICY "Authenticated participants read direct messages"')
    expect(migration).toContain('CREATE POLICY "Service role manages conversations"')
    expect(migration).toContain('CREATE POLICY "Service role manages direct messages"')
    expect(migration).toContain('direct-message policy exact-definition postflight failed')
    expect(migration).toContain('policy.polwithcheck IS NULL')
    expect(migration).not.toContain('strpos(\n        pg_catalog.pg_get_expr(policy.polqual')
  })

  it('canonicalizes insert previews too, closing backdated-insert leakage', () => {
    const insertBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.update_conversation_on_message\(\)[\s\S]*?\n\$function\$;/
    )?.[0]
    expect(insertBody).toContain("TG_OP IS DISTINCT FROM 'INSERT'")
    expect(insertBody).toContain('public.recalculate_direct_message_conversation_summary(')
    expect(insertBody).not.toContain('last_message_preview = pg_catalog.left(NEW.content')
  })

  it('converges arbitrary ACLs and postflights catalog plus calibrated data', () => {
    expect(migration).toContain('DO $converge_function_acls$')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('retained an arbitrary function ACL')
    expect(migration).toContain('20260716114000 arbitrary table/column ACL drift detected')
    expect(migration).toContain(
      'direct_messages has unexpected, disabled, or duplicate user triggers'
    )
    expect(migration).toContain('conversation summaries did not calibrate canonically')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('does not switch the application delete route in this SQL-first batch', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/messages/[messageId]/route.ts'), 'utf8')
    expect(route).not.toContain('delete_direct_message_atomic')
    expect(route).toContain('.update({ deleted_at: new Date().toISOString() })')
  })
})
