import { renderToStaticMarkup } from 'react-dom/server'
import { BreakdownSection } from '../BreakdownSection'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/common/CryptoIcon', () => ({
  __esModule: true,
  default: ({ symbol }: { symbol: string }) => <span data-crypto-symbol={symbol} />,
}))

function renderStaticBreakdown(
  assetBreakdown: {
    '90D': Array<{ symbol: string; weightPct: number }>
    '30D': Array<{ symbol: string; weightPct: number }>
    '7D': Array<{ symbol: string; weightPct: number }>
  },
  fallbackData: Array<{ symbol: string; weightPct: number }> = []
) {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    <BreakdownSection assetBreakdown={assetBreakdown} fallbackData={fallbackData} delay={0} />
  )
  return container
}

describe('BreakdownSection server visibility', () => {
  it('renders the first populated asset period when 90D is empty', () => {
    const container = renderStaticBreakdown({
      '90D': [],
      '30D': [{ symbol: 'ETH', weightPct: 65 }],
      '7D': [{ symbol: 'SOL', weightPct: 35 }],
    })

    expect(container).toHaveTextContent('ETH')
    expect(container).not.toHaveTextContent('SOL')
    expect(container.querySelector('.asset-bar')).toHaveAttribute('title', 'ETH: 65.00%')
    expect(container.querySelector('button[aria-pressed="true"]')).toHaveTextContent('30D')
  })

  it('renders fallback data when every asset period is empty', () => {
    const container = renderStaticBreakdown({ '90D': [], '30D': [], '7D': [] }, [
      { symbol: 'BTC', weightPct: 100 },
    ])

    expect(container).toHaveTextContent('BTC')
    expect(container.querySelector('.asset-bar')).toHaveAttribute('title', 'BTC: 100.00%')
    expect(container.querySelector('button[aria-pressed="true"]')).toHaveTextContent('90D')
  })
})
