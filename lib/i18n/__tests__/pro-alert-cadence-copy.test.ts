import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

describe('Pro alert V1 availability copy', () => {
  const dictionaries = { en, zh, ja, ko }

  it.each(Object.entries(dictionaries))(
    '%s states that alert monitoring is unavailable during V1',
    (_locale, dictionary) => {
      const copy = [
        dictionary.alertCheckCadence,
        dictionary.pricingProAlerts,
        dictionary.gateBenefitAlertsRealtime,
      ].join(' ')

      expect(copy).toMatch(/V1/)
      expect(copy).toMatch(/unavailable|暂不可用|一時停止|사용할 수 없습니다/i)
      expect(copy).not.toMatch(/30s*(?:minutes?|分|분마다)/i)
      expect(copy).not.toMatch(/real[- ]?time|实时|リアルタイム|실시간/i)
    }
  )

  it('has no automatic alert schedule and removes the invented free/Pro refresh row', () => {
    const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path: string; schedule: string }>
    }
    expect(Object.hasOwn(vercelConfig, 'crons')).toBe(false)
    expect(vercelConfig.crons ?? []).toHaveLength(0)
    expect(vercelConfig.crons ?? []).not.toContainEqual({
      path: '/api/cron/check-trader-alerts',
      schedule: expect.any(String),
    })

    const comparison = readFileSync(
      join(process.cwd(), 'app/(app)/user-center/membership-config.ts'),
      'utf8'
    )
    expect(comparison).not.toContain("t('compFeatureRealtimeData')")
    expect(comparison).not.toContain("t('compProRealtimePush')")
  })
})
