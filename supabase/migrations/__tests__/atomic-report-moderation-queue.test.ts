import fs from 'fs'
import path from 'path'

const root = process.cwd()
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260716154731_atomic_report_moderation_queue.sql'),
  'utf8'
)
const queueRoute = fs.readFileSync(
  path.join(root, 'app/api/admin/moderation-queue/route.ts'),
  'utf8'
)
const reportsRoute = fs.readFileSync(path.join(root, 'app/api/admin/reports/route.ts'), 'utf8')
const pg17Proof = fs.readFileSync(
  path.join(root, 'supabase/migrations/__tests__/atomic-report-moderation-queue.pg17.sh'),
  'utf8'
)

describe('atomic report moderation queue contract', () => {
  it('publishes service-only submission and moderation SECURITY DEFINER RPCs', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.submit_content_report\([\s\S]*p_reporter_id uuid,[\s\S]*p_content_type text,[\s\S]*p_content_id uuid,[\s\S]*RETURNS jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.moderate_report_queue_atomic\([\s\S]*p_actor_id uuid,[\s\S]*p_content_type text,[\s\S]*p_content_id uuid,[\s\S]*p_action text[\s\S]*RETURNS TABLE[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/
    )
    expect(migration).toContain(
      "COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'"
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.moderate_report_queue_atomic\(uuid, text, uuid, text\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.moderate_report_queue_atomic\(uuid, text, uuid, text\)[\s\S]*TO service_role/
    )
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.submit_content_report\([\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    )
    expect(migration).toContain('62454ccfd4e7efbc21ce7197964cc313')
    expect(migration).toContain('50c413fbae8ce4e83b16e6c1466c5d25')
    expect(migration).toContain('ALTER COLUMN issued_by DROP NOT NULL')
    expect(migration).toContain('user_strikes.issued_by must permit ON DELETE SET NULL')
  })

  it('gives submission and moderation one target-first lock protocol', () => {
    const submitFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.submit_content_report'),
      migration.indexOf('ALTER FUNCTION public.submit_content_report')
    )
    const moderationFunction = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.moderate_report_queue_atomic'),
      migration.indexOf('ALTER FUNCTION public.moderate_report_queue_atomic')
    )
    const submitTargetLock = submitFunction.indexOf("'report-moderation:'")
    const reporterLock = submitFunction.indexOf("'content-report:'")
    const reporterAuthLock = submitFunction.indexOf('FROM auth.users AS reporter_auth_user')
    const reporterProfileLock = submitFunction.indexOf('FROM public.user_profiles AS reporter')
    expect(submitTargetLock).toBeGreaterThan(0)
    expect(reporterLock).toBeGreaterThan(submitTargetLock)
    expect(reporterAuthLock).toBeGreaterThan(reporterLock)
    expect(reporterProfileLock).toBeGreaterThan(reporterAuthLock)
    expect(submitFunction.indexOf('FOR SHARE')).toBeGreaterThan(reporterAuthLock)
    expect(submitFunction).toContain('ORDER BY upload_row.evidence_ref')
    expect(submitFunction).toContain('FROM storage.objects AS object_row')
    expect(submitFunction).toContain('report evidence claim race detected')

    const targetLock = moderationFunction.indexOf("'report-moderation:'")
    const authLock = moderationFunction.indexOf('FROM auth.users AS auth_user')
    const sanctionLock = moderationFunction.indexOf("'report-moderation-sanction:'")
    const actorProfileLock = moderationFunction.indexOf(
      'FROM public.user_profiles AS actor_profile'
    )
    const postLock = moderationFunction.indexOf('FROM public.posts AS post_row', targetLock)
    const reportLock = moderationFunction.indexOf(
      'FROM public.content_reports AS report_row',
      postLock
    )
    expect(targetLock).toBeGreaterThan(0)
    expect(authLock).toBeGreaterThan(targetLock)
    expect(sanctionLock).toBeGreaterThan(authLock)
    expect(actorProfileLock).toBeGreaterThan(sanctionLock)
    expect(moderationFunction.indexOf('FOR SHARE')).toBeGreaterThan(authLock)
    expect(moderationFunction.indexOf('FOR UPDATE')).toBeGreaterThan(authLock)
    expect(postLock).toBeGreaterThan(targetLock)
    expect(reportLock).toBeGreaterThan(postLock)
    expect(moderationFunction.slice(reportLock, reportLock + 500)).toContain('FOR UPDATE')
    expect(moderationFunction).toContain("v_next_report_status := 'dismissed'")
    expect(moderationFunction).toContain("v_next_report_status := 'resolved'")
    expect(moderationFunction).toContain('resolved_at = v_now')
    expect(moderationFunction).toContain(
      'v_report_update_count <> pg_catalog.cardinality(v_report_ids)'
    )
    expect(moderationFunction).toContain("'report-moderation-sanction:'")
  })

  it('proves target, sanction, and auth-deletion concurrency on PostgreSQL 17', () => {
    expect(pg17Proof).toContain('submit-vs-moderation-submit.log')
    expect(pg17Proof).toContain('submit-vs-moderation-action.log')
    expect(pg17Proof).toContain('moderation missed the submission that linearized first')
    expect(pg17Proof).toContain('concurrent-warn-$target_suffix.log')
    expect(pg17Proof).toContain('same-author warnings did not serialize escalation')
    expect(pg17Proof).toContain('"mute warning "')
    expect(pg17Proof).toContain('submit-first-vs-reporter-delete-submit.log')
    expect(pg17Proof).toContain('reporter-delete-first-submit.log')
    expect(pg17Proof).toContain('moderation-first-vs-author-delete-action.log')
    expect(pg17Proof).toContain('author-delete-first-action.log')
    expect(pg17Proof).toContain('moderation-first-vs-actor-delete-action.log')
    expect(pg17Proof).toContain('actor-delete-first-action.log')
    expect(pg17Proof).toContain("'42501.*active reporter identity required'")
    expect(pg17Proof).toContain("'P0002.*reported content identity is unavailable'")
  })

  it('accepts only a matching latest processed batch as an idempotent replay', () => {
    expect(migration).toContain('v_latest_resolved_at')
    expect(migration).toContain('locked_history')
    expect(migration).toContain("MESSAGE = 'processed report history not found'")
    expect(migration).toContain("MESSAGE = 'latest moderation action conflicts with request'")
    expect(migration).toContain("v_latest_report_status_min IS DISTINCT FROM 'dismissed'")
    expect(migration).toContain("v_latest_action_taken_min IS DISTINCT FROM 'user_warned'")
    expect(pg17Proof).toContain('approve replay evidence is invalid')
    expect(pg17Proof).toContain('delete replay evidence is invalid')
    expect(pg17Proof).toContain('warn replay repeated a sanction')
    expect(pg17Proof).toContain('ban replay evidence is invalid')
    expect(pg17Proof).toContain('approve-to-delete cross action was accepted')
    expect(pg17Proof).toContain('delete-to-approve cross action was accepted')
    expect(pg17Proof).toContain('warn-to-ban cross action was accepted')
    expect(pg17Proof).toContain('ban-to-warn cross action was accepted')
    expect(pg17Proof).toContain('unknown target was accepted as an idempotent replay')
    expect(pg17Proof).toContain('older matching action hid a newer moderation conflict')
    expect(queueRoute).toContain("if (error.code === '40001')")
    expect(queueRoute).toContain("code: 'DUPLICATE_ACTION'")
  })

  it('keeps content, sanctions, report transitions, and audit writes in the RPC transaction', () => {
    expect(migration).toContain('UPDATE public.posts AS moderated_post')
    expect(migration).toContain("'soft_delete'")
    expect(migration).toContain('INSERT INTO public.user_strikes')
    expect(migration).toContain('UPDATE public.user_profiles AS target_profile')
    expect(migration).toContain('UPDATE public.content_reports AS transitioned_report')
    expect(migration).toContain('INSERT INTO public.admin_logs')
    expect(migration).toContain('IF report_count = 0 THEN')
    expect(migration).toContain('applied := false')
  })

  it('routes every queue action through the RPC with no direct mutation fallback or auto restore', () => {
    const postHandler = queueRoute.slice(queueRoute.indexOf('export async function POST'))
    expect(postHandler).toContain("supabase.rpc('moderate_report_queue_atomic'")
    expect(postHandler).not.toContain(".from('")
    expect(postHandler).not.toContain('autoEscalate')
    expect(postHandler).not.toContain('restore_auto_hidden')
    expect(postHandler).not.toContain("status: 'actioned'")
  })

  it('rejects legacy report statuses at the adjacent admin endpoint', () => {
    const postHandler = reportsRoute.slice(reportsRoute.indexOf('export async function POST'))
    expect(postHandler).toContain("['resolved', 'dismissed'].includes(status)")
    expect(postHandler).not.toContain("['reviewed', 'actioned', 'dismissed']")
    expect(postHandler).toContain(".eq('status', 'pending')")
    expect(postHandler).toContain('resolved_at: resolvedAt')
  })
})
