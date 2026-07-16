import { PRODUCT_FACTS } from '@/lib/config/product-facts'

import { ARTICLES, type Localized } from './articles'

const LOCALES: Array<keyof Localized> = ['en', 'zh', 'ja', 'ko']
const SOURCE_COVERAGE: Localized = {
  en: `${PRODUCT_FACTS.fallbackExchangeCount}+ active source families`,
  zh: `${PRODUCT_FACTS.fallbackExchangeCount}+ 个活跃来源家族`,
  ja: `${PRODUCT_FACTS.fallbackExchangeCount} 以上のアクティブなソースファミリー`,
  ko: `${PRODUCT_FACTS.fallbackExchangeCount}개 이상의 활성 소스 패밀리`,
}

function article(slug: string) {
  const match = ARTICLES.find((candidate) => candidate.slug === slug)
  if (!match) throw new Error(`Missing Learn article: ${slug}`)
  return match
}

describe('Learn article product contracts', () => {
  it.each(['understanding-trader-rankings', 'top-traders-by-exchange'])(
    '%s uses the shared active-source fallback in every locale',
    (slug) => {
      const target = article(slug)
      const expectedCount = String(PRODUCT_FACTS.fallbackExchangeCount)

      for (const locale of LOCALES) {
        expect(target.excerpt[locale]).toContain(SOURCE_COVERAGE[locale])
        expect(target.content[locale]).toContain(SOURCE_COVERAGE[locale])
        expect(`${target.excerpt[locale]} ${target.content[locale]}`).not.toContain('45')
        expect(`${target.excerpt[locale]} ${target.content[locale]}`).toContain(expectedCount)
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
