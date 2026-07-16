import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const migration = read('supabase/migrations/20260716164000_group_application_operation_replay.sql')
const applyRoute = read('app/api/groups/apply/route.ts')
const approveRoute = read('app/api/groups/applications/[id]/approve/route.ts')
const rejectRoute = read('app/api/groups/applications/[id]/reject/route.ts')
const applyPage = read('app/(app)/groups/apply/page.tsx')
const applicationsHook = read('app/(app)/admin/hooks/useApplications.ts')

describe('group application operation replay migration', () => {
  it('creates an exact permanent no-FK ledger only on a fresh install', () => {
    const createStart = migration.indexOf('DO $create_ledger_only_when_absent$')
    const lockStart = migration.indexOf('DO $acquire_complete_ddl_lock_set$')
    const createSection = migration.slice(createStart, lockStart)

    expect(createStart).toBeGreaterThan(0)
    expect(createSection).toContain(
      "pg_catalog.to_regclass(\n    'public.group_application_operation_results'"
    )
    expect(createSection).toContain('CREATE TABLE public.group_application_operation_results')
    expect(createSection).not.toContain('CREATE TABLE IF NOT EXISTS')
    expect(createSection).not.toContain('REFERENCES')
    expect(migration).toContain("intent_fingerprint ~ '^[0-9a-f]{64}$'")
    expect(migration).toContain("relation.relpersistence = 'p'")
    expect(migration).toContain("constraint_row.contype = 'f'")
    expect(migration).toContain(
      'ALTER TABLE public.group_application_operation_results FORCE ROW LEVEL SECURITY'
    )
    expect(migration).toContain('operation result ledger catalog drifted')
  })

  it('takes the complete all-or-nothing DDL lock set before any replay mutation', () => {
    const lockSet = migration.indexOf('DO $acquire_complete_ddl_lock_set$')
    const ledgerLock = migration.indexOf('IN ACCESS EXCLUSIVE MODE NOWAIT', lockSet)
    const authLock = migration.indexOf(
      'LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      lockSet
    )
    const dependencyLock = migration.indexOf('LOCK TABLE public.user_profiles,', lockSet)
    const mutation = migration.indexOf(
      'ALTER TABLE public.group_application_operation_results OWNER TO postgres',
      lockSet
    )

    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min'")
    expect(migration).toContain(
      "pg_catalog.hashtextextended('group-application-authority-migrations', 0)"
    )
    expect(ledgerLock).toBeGreaterThan(lockSet)
    expect(authLock).toBeGreaterThan(ledgerLock)
    expect(dependencyLock).toBeGreaterThan(authLock)
    expect(mutation).toBeGreaterThan(dependencyLock)
    expect(migration).toContain('WHEN lock_not_available OR deadlock_detected')
    expect(migration).toContain('could not acquire complete group-application DDL lock set')
  })

  it('makes both promoted runtimes enter through the ledger deployment barrier', () => {
    const submitStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.submit_group_application_atomic'
    )
    const reviewStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.review_group_application_atomic'
    )
    const submitBody = migration.slice(submitStart, reviewStart)
    const reviewBody = migration.slice(reviewStart)

    for (const body of [submitBody, reviewBody]) {
      const barrier = body.indexOf(
        'LOCK TABLE public.group_application_operation_results IN ROW EXCLUSIVE MODE'
      )
      const ledgerRead = body.indexOf('FROM public.group_application_operation_results AS ledger')
      const authRead = body.indexOf('FROM auth.users AS auth_user')
      expect(barrier).toBeGreaterThan(0)
      expect(ledgerRead).toBeGreaterThan(barrier)
      expect(authRead).toBeGreaterThan(barrier)
    }
  })

  it('replays actor-and-intent-bound outcomes before checking mutable state', () => {
    expect(migration.match(/pg_catalog\.sha256\(/g)).toHaveLength(2)
    expect(migration).toContain("'group-application-operation:' || v_effective_operation_id::text")
    expect(migration).toContain(
      "RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict')"
    )
    expect(migration).toMatch(
      /FROM public\.group_application_operation_results AS ledger[\s\S]*?RETURN v_existing_result \|\|[\s\S]*?'applied', false/
    )
    expect(migration).toContain("RETURN v_result || pg_catalog.jsonb_build_object('applied', true)")
    expect(migration).toContain('v_is_legacy boolean := p_operation_id IS NULL')
    expect(migration).toContain('p_operation_id uuid DEFAULT NULL')
  })

  it('commits one deterministic in-app notification with each new review outcome', () => {
    const reviewStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.review_group_application_atomic'
    )
    const reviewBody = migration.slice(reviewStart)
    const reviewUpdate = reviewBody.indexOf('UPDATE public.group_applications')
    const notification = reviewBody.indexOf('INSERT INTO public.notifications')
    const ledgerWrite = reviewBody.indexOf(
      'INSERT INTO public.group_application_operation_results',
      notification
    )

    expect(reviewBody).toContain(
      "'group-application-notification:' || v_effective_operation_id::text"
    )
    expect(notification).toBeGreaterThan(reviewUpdate)
    expect(ledgerWrite).toBeGreaterThan(notification)
    expect(reviewBody).toContain('WHEN v_is_legacy THEN')
    expect(reviewBody).toContain("'operation_id', v_effective_operation_id")
  })

  it('requires exact operation acknowledgements at every HTTP boundary', () => {
    expect(applyRoute).toContain('operation_id: z.string().uuid()')
    expect(applyRoute).toContain('p_operation_id: input.operation_id')
    expect(applyRoute).toContain('result.operation_id !== input.operation_id')

    for (const route of [approveRoute, rejectRoute]) {
      expect(route).toContain('p_operation_id: parsedBody.data.operation_id')
      expect(route).toContain('result.operation_id !== parsedBody.data.operation_id')
      expect(route).not.toContain('sendNotification')
    }
    expect(approveRoute).toContain('if (result.applied) void notifyNewGroup')
  })

  it('wires the stable operation and viewer-generation guards into the live clients', () => {
    for (const client of [applyPage, applicationsHook]) {
      expect(client).toContain('useViewerSlotState')
      expect(client).toContain('runGroupApplicationSingleFlight')
      expect(client).toContain('isCurrentGroupApplicationOperation')
      expect(client).toContain('isViewerScopeCurrent')
      expect(client).toContain('expectedSessionGeneration')
    }
    expect(applyPage).toContain('isExactSubmitGroupApplicationAck')
    expect(applicationsHook).toContain('isExactApproveGroupApplicationAck')
    expect(applicationsHook).toContain('isExactRejectGroupApplicationAck')
  })
})
