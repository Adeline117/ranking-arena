import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../en'
import zh from '../zh'
import ja from '../ja'
import ko from '../ko'

describe('Pro alert cadence copy', () => {
  const dictionaries = { en, zh, ja, ko }

  it.each(Object.entries(dictionaries))(
    '%s states the scheduled cadence without promising real-time delivery',
    (_locale, dictionary) => {
      const copy = [
        dictionary.alertCheckCadence,
        dictionary.pricingProAlerts,
        dictionary.gateBenefitAlertsRealtime,
      ].join(' ')

      expect(copy).toContain('30')
      expect(copy).not.toMatch(/real[- ]?time|实时|リアルタイム|실시간/i)
    }
  )

  it('matches the deployed cron schedule and removes the invented free/Pro refresh row', () => {
    const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
    }
    expect(
      vercelConfig.crons.find((cron) => cron.path === '/api/cron/check-trader-alerts')?.schedule
    ).toBe('*/30 * * * *')

    const comparison = readFileSync(
      join(process.cwd(), 'app/(app)/user-center/membership-config.ts'),
      'utf8'
    )
    expect(comparison).not.toContain("t('compFeatureRealtimeData')")
    expect(comparison).not.toContain("t('compProRealtimePush')")
  })
})
