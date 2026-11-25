import { renderToStaticMarkup } from 'react-dom/server'
import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'
import TraderServerSummary, {
  buildTraderSummaryRows,
  summaryDataNote,
} from '../TraderServerSummary'

const dict: Record<string, string> = en
const t = (key: string) => dict[key] ?? key

function html(props: Partial<Parameters<typeof TraderServerSummary>[0]>) {
  return renderToStaticMarkup(
    <TraderServerSummary
      name="Alice"
      exchange="OKX (Futures)"
      windowLabel="90D"
      metrics={{}}
      similar={[]}
      t={t}
      {...props}
    />
  )
}

describe('TraderServerSummary', () => {
  it('renders nothing at all when there is no metric and no similar trader', () => {
    expect(html({})).toBe('')
    expect(html({ metrics: { rank: null, roi: undefined, pnl: Number.NaN } })).toBe('')
  })

  it('puts the resolved metrics into the server HTML as text', () => {
    const out = html({
      metrics: {
        rank: 12,
        arenaScore: 81.26,
        roi: 153.4,
        pnl: -2500,
        winRate: 61.25,
        maxDrawdown: 18.2,
      },
    })
    expect(out).toContain('>At a glance</h2>')
    expect(out).toContain(
      '90D performance on OKX (Futures), from Arena&#x27;s current public ranking.'
    )
    for (const text of ['#12', '81.3', '+153.4%', '-$2.5K', '61.3%', '-18.2%']) {
      expect(out).toContain(text)
    }
    for (const label of ['Rank', 'Arena Score', 'ROI', 'PnL', 'Win Rate', 'Max Drawdown']) {
      expect(out).toContain(`>${label}</dt>`)
    }
  })

  it('never repeats the trader name in a heading (the profile h1 is the only one)', () => {
    const out = html({
      metrics: { roi: 10 },
      similar: [{ name: 'Bob', href: '/trader/Bob?platform=x' }],
    })
    const headings = out.match(/<h[1-6][^>]*>.*?<\/h[1-6]>/g) ?? []
    expect(headings.length).toBeGreaterThan(0)
    for (const heading of headings) expect(heading).not.toContain('Alice')
  })

  it('omits a missing metric instead of printing a placeholder', () => {
    const rows = buildTraderSummaryRows({ roi: 10, winRate: null, rank: 0 }, t)
    expect(rows.map((row) => row.key)).toEqual(['roi'])
    expect(html({ metrics: { roi: 10 } })).not.toContain('—')
  })

  it('links similar traders with real anchors and skips the lead when only they exist', () => {
    const out = html({
      similar: [
        { name: 'Bob', href: '/trader/Bob?platform=okx_futures', roi: -4.5 },
        { name: '0xabc', href: '/trader/0xabc?platform=hyperliquid' },
      ],
    })
    expect(out).toContain('<a href="/trader/Bob?platform=okx_futures"')
    expect(out).toContain('<a href="/trader/0xabc?platform=hyperliquid"')
    expect(out).toContain('-4.50%')
    expect(out).toContain('Similar Traders')
    expect(out).not.toContain('performance on')
    expect(out).not.toContain('<dl')
  })

  it('has its copy in every language, with the placeholders intact', () => {
    for (const language of [en, zh, ja, ko] as Record<string, string>[]) {
      expect(language.traderSummaryHeading).toBeTruthy()
      expect(language.traderSummaryLead).toContain('{name}')
      expect(language.traderSummaryLead).toContain('{window}')
      expect(language.traderSummaryLead).toContain('{exchange}')
    }
  })
})

describe('summary data note (L1: public leaderboard data)', () => {
  it('names the data level, the exchange and the capture time in UTC', () => {
    const note = summaryDataNote({
      exchange: 'Binance',
      dataAsOf: '2026-11-24T18:05:00.000Z',
      language: 'en',
      t,
    })
    expect(note).toMatch(/^Public leaderboard data · Binance · as of /)
    expect(note).toContain('Nov 24, 2026')
    expect(note).toContain('UTC')
  })

  it('leaves the time out when it is unknown instead of inventing one', () => {
    for (const dataAsOf of [null, undefined, '', 'not-a-date']) {
      expect(summaryDataNote({ exchange: 'Binance', dataAsOf, language: 'en', t })).toBe(
        'Public leaderboard data · Binance'
      )
    }
  })

  it('is rendered with the metrics and not on a summary that has none', () => {
    const withMetrics = html({ metrics: { roi: 12.5 }, dataAsOf: '2026-11-24T18:05:00.000Z' })
    expect(withMetrics).toContain('data-testid="trader-summary-data-note"')
    expect(withMetrics).toContain('Public leaderboard data')
    const linksOnly = html({ similar: [{ name: 'Bob', href: '/trader/bob?platform=okx' }] })
    expect(linksOnly).not.toContain('trader-summary-data-note')
  })

  it('has the copy in every language', () => {
    for (const lang of [en, zh, ja, ko] as Array<Record<string, string>>) {
      expect(lang.publicLeaderboardData).toBeTruthy()
      expect(lang.rowDataAsOf).toContain('{time}')
    }
  })
})

describe('idle-window account (ranked, no trading, not scored)', () => {
  it('says there was no trading and never prints a score', () => {
    const markup = html({
      idleWindow: true,
      metrics: { rank: 4261, arenaScore: 0.01, roi: 0, pnl: 0 },
    })
    expect(markup).toContain('data-testid="trader-summary-idle"')
    expect(markup).toContain(en.noTradingThisPeriod)
    expect(markup).toContain('#4261')
    expect(markup).not.toContain(en.arenaScore)
    expect(markup).not.toContain('&lt;1')
  })

  it('still renders the note when there is nothing else to show', () => {
    const markup = html({ idleWindow: true })
    expect(markup).toContain(en.noTradingThisPeriod)
  })

  it('does not show the note for an account that traded', () => {
    expect(html({ metrics: { roi: 12.5, arenaScore: 0.3 } })).not.toContain('trader-summary-idle')
  })
})
