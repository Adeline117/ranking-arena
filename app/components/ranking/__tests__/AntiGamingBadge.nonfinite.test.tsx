import { render, screen } from '@testing-library/react'
import AntiGamingBadge from '../AntiGamingBadge'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      key === 'antiGamingWinRateTip' ? 'Win rate {winRate}, trades {trades}' : key,
  }),
}))

describe('AntiGamingBadge non-finite metric boundary', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'keeps corrupt tooltip metrics unknown for %p',
    (metric) => {
      render(
        <AntiGamingBadge flags={['implausible_win_rate']} winRate={metric} tradesCount={metric} />
      )

      expect(screen.getByRole('img')).toHaveAccessibleName('Win rate ?, trades ?')
      expect(document.body).not.toHaveTextContent('NaN')
      expect(document.body).not.toHaveTextContent('Infinity')
    }
  )
})
