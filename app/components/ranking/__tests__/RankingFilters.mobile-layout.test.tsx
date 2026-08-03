import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { RankingFilters } from '../RankingFilters'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'ja',
    t: (key: string) =>
      (
        ({
          allTraderTypes: 'すべて',
          isHuman: 'トレーダー',
          isBot: 'ボット',
          traderTypeFilter: 'トレーダータイプ',
          advancedFilter: '詳細フィルター',
          filter: 'フィルター',
          compareTraders: 'トレーダーを比較',
          compare: '比較',
          rowDensity: '行の密度',
          densityComfortable: '標準',
          densityCompact: 'コンパクト',
          columnSettingsTitle: '列の設定',
          resetToDefault: '初期設定に戻す',
          proFeature: 'Pro 機能',
          exportRankingShort: '出力',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/lib/premium/hooks', () => ({
  BETA_PRO_FEATURES_FREE: true,
}))

const responsiveCss = readFileSync(join(process.cwd(), 'public/styles/responsive.css'), 'utf8')

describe('RankingFilters compact localized layout', () => {
  it('keeps long trader-type labels in a scrollable lane beside reachable actions', () => {
    const { container } = render(
      <RankingFilters
        category="all"
        onCategoryChange={jest.fn()}
        isPro
        filterOpen={false}
        onFilterToggle={jest.fn()}
        visibleColumns={['score', 'roi']}
        showColumnSettings={false}
        onShowColumnSettings={jest.fn()}
        onToggleColumn={jest.fn()}
        onResetColumns={jest.fn()}
        styleFilter="all"
        onStyleFilterChange={jest.fn()}
        hasStyleData={false}
        scoreGradeFilter="all"
        onScoreGradeFilterChange={jest.fn()}
        traderTypeFilter="all"
        onTraderTypeFilterChange={jest.fn()}
        traders={[]}
        density="comfortable"
        onDensityChange={jest.fn()}
      />
    )

    const toolbar = container.querySelector('.ranking-toolbar-row')
    const typeLane = screen.getByRole('group', { name: 'トレーダータイプ' })

    expect(toolbar).toContainElement(typeLane)
    expect(typeLane).toHaveClass('ranking-trader-type-filter')
    expect(
      within(typeLane)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['すべて', 'トレーダー', '⚡ボット'])
    expect(screen.getByRole('button', { name: '詳細フィルター' })).toBeVisible()
    expect(screen.getByRole('link', { name: /比較/ })).toBeVisible()

    expect(responsiveCss).toMatch(
      /\.ranking-toolbar-row \.ranking-trader-type-filter\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto !important;[^}]*overflow-x:\s*auto;/s
    )
    expect(responsiveCss).toMatch(
      /\.ranking-toolbar-row \.ranking-trader-type-filter::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/s
    )
    expect(responsiveCss).not.toMatch(
      /\.ranking-toolbar-row > \*:first-child\s*\{[^}]*width:\s*100%;/s
    )
  })
})
