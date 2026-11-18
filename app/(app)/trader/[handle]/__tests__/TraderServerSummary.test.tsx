import { renderToStaticMarkup } from 'react-dom/server'
import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'
import TraderServerSummary, { buildTraderSummaryRows } from '../TraderServerSummary'

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
    expect(out).toContain('Alice at a glance')
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
      expect(language.traderSummaryHeading).toContain('{name}')
      expect(language.traderSummaryLead).toContain('{window}')
      expect(language.traderSummaryLead).toContain('{exchange}')
    }
  })
})
