import { ARTICLES, type Localized } from './articles'

const LOCALES: Array<keyof Localized> = ['en', 'zh', 'ja', 'ko']
const SOURCE_COVERAGE: Localized = {
  en: 'live CEX, DEX, and on-chain source boards',
  zh: '当前有数据的 CEX、DEX 与链上来源板',
  ja: '稼働中の CEX・DEX・オンチェーンのソースボード',
  ko: '운영 중인 CEX, DEX 및 온체인 소스 보드',
}

function article(slug: string) {
  const match = ARTICLES.find((candidate) => candidate.slug === slug)
  if (!match) throw new Error(`Missing Learn article: ${slug}`)
  return match
}

describe('Learn article product contracts', () => {
  it.each(['understanding-trader-rankings', 'top-traders-by-exchange'])(
    '%s describes live ranking boards without a stale numeric claim in every locale',
    (slug) => {
      const target = article(slug)

      for (const locale of LOCALES) {
        expect(target.excerpt[locale]).toContain(SOURCE_COVERAGE[locale])
        expect(target.content[locale]).toContain(SOURCE_COVERAGE[locale])
        expect(`${target.excerpt[locale]} ${target.content[locale]}`).not.toMatch(
          /(?:18|25|27|30|44|45)\+/
        )
      }
    }
  )

  it('keeps the DEX explainer aligned with currently served source families', () => {
    const target = article('cex-vs-dex')

    for (const locale of LOCALES) {
      const copy = target.content[locale]
      expect(copy).toContain('Hyperliquid')
      expect(copy).toContain('GMX')
      expect(copy).toContain('gTrade')
      expect(copy).not.toMatch(/dYdX|Drift|Vertex/)
    }
  })

  it('does not promise fairness from units or percentiles alone', () => {
    const target = article('cex-vs-dex')
    const copy = LOCALES.map((locale) => target.content[locale]).join('\n')

    expect(copy).not.toMatch(/ensures?\b[^.\n]*fair|确保[^。\n]*公平|公平に比較|공정하게 비교/i)
    expect(copy).not.toMatch(/penaliz|惩罚|罰則|페널티/i)
    expect(copy).toMatch(/matching units alone do not make two metrics equivalent/i)
  })

  it('keeps serving scope separate from protocol and bounded-board scope', () => {
    const target = article('top-traders-by-exchange')

    for (const locale of LOCALES) {
      const copy = target.content[locale]
      for (const evidence of ['node/S3', 'Arbitrum', 'Avalanche', 'MegaETH', 'gTrade', 'Top-25']) {
        expect(copy).toContain(evidence)
      }
      expect(copy).not.toMatch(/dYdX|Drift|Vertex/)
      expect(copy).not.toContain('60%')
    }
  })
})
