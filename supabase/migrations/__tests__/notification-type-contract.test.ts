import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const migration = read('supabase/migrations/20260717222500_notification_type_contract.sql')
const notificationTypes = read('lib/types/notification.ts')
const notificationData = read('lib/data/notifications.ts')
const notificationsRoute = read('app/api/notifications/route.ts')

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

describe('notification type contract migration', () => {
  it('installs transactionally under a bounded table lock', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain("SET LOCAL statement_timeout = '1min'")
    expect(migration).toContain("'notification-type-contract'")
    expect(migration).toContain('LOCK TABLE public.notifications IN ACCESS EXCLUSIVE MODE')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })

  it('matches the single canonical TypeScript notification vocabulary', () => {
    const typeBlock = notificationTypes.slice(
      notificationTypes.indexOf('export const PERSISTED_NOTIFICATION_TYPES'),
      notificationTypes.indexOf('] as const')
    )
    const applicationTypes = [...typeBlock.matchAll(/^\s*'([^']+)',?$/gm)].map((match) => match[1])
    const constraintBlock = migration.slice(
      migration.indexOf('ADD CONSTRAINT notifications_type_check CHECK'),
      migration.indexOf(') NOT VALID;')
    )
    const databaseTypes = [...constraintBlock.matchAll(/'([^']+)'/g)].map((match) => match[1])

    expect(uniqueSorted(databaseTypes)).toEqual(uniqueSorted(applicationTypes))
    expect(databaseTypes).toEqual(expect.arrayContaining(['reaction', 'nft_pending', 'nft_minted']))
    expect(databaseTypes).toHaveLength(25)
    expect(notificationData).toContain(
      "import type { NotificationType as PersistedNotificationType } from '@/lib/types/notification'"
    )
    expect(notificationData).toContain('export type NotificationType = PersistedNotificationType')
    expect(notificationData).not.toContain("  | 'reaction'")
  })

  it('keeps restored reaction events inside the social feature boundary', () => {
    const socialTypes = notificationsRoute.slice(
      notificationsRoute.indexOf('const SOCIAL_NOTIFICATION_TYPES'),
      notificationsRoute.indexOf('export const GET')
    )
    expect(socialTypes).toContain("'reaction'")
  })

  it('fails closed on schema drift or unclassified historical values', () => {
    expect(migration).toContain('public.notifications must be a postgres-owned table')
    expect(migration).toContain('public.notifications.type must be unbounded text NOT NULL')
    expect(migration).toContain('notifications_type_check name collision was preserved')
    expect(migration).toContain('unknown persisted notification types must be classified first')
    expect(migration.indexOf('DO $preflight$')).toBeLessThan(
      migration.indexOf('DO $drop_stale_type_checks$')
    )
  })

  it('converges every stale single-column type check without touching composite checks', () => {
    expect(migration).toContain('DO $drop_stale_type_checks$')
    expect(migration).toContain('constraint_row.conkey =\n        ARRAY[v_type_attnum]::smallint[]')
    expect(migration).toContain("'ALTER TABLE public.notifications DROP CONSTRAINT %I'")
    expect(migration).toContain('ADD CONSTRAINT notifications_type_check CHECK')
    expect(migration).toContain('VALIDATE CONSTRAINT notifications_type_check')
  })

  it('postflights the unique validated expression and persisted rows', () => {
    expect(migration).toContain('DO $postflight$')
    expect(migration).toContain('constraint_row.convalidated')
    expect(migration).toContain("'4202c98e274ce25029f78eefd1beedcd'")
    expect(migration).toContain('persisted notifications violate the type contract')
  })
})
