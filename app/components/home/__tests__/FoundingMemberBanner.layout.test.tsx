import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import FoundingMemberBanner from '../FoundingMemberBanner'
import { FOUNDING_MEMBER_BANNER_HEIGHT } from '../founding-member-layout'

const mockLongLocaleCopy: Record<string, string> = {
  foundingMemberBannerText:
    'ファウンディングメンバー — $49.99で永久アクセスできる期間限定メンバーシップ',
  foundingMemberBannerCta: '今すぐメンバーシップを取得',
  foundingMemberFirst200: '先着200名限定',
  dismiss: '閉じる',
}

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => mockLongLocaleCopy[key] ?? key,
  }),
}))

jest.mock('@/lib/premium/hooks', () => ({
  BETA_PRO_FEATURES_FREE: false,
}))

describe('FoundingMemberBanner fixed-row layout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps long localized copy shrinkable inside the reserved row', () => {
    render(<FoundingMemberBanner />)

    expect(screen.getByTestId('founding-member-banner')).toHaveStyle({
      height: `${FOUNDING_MEMBER_BANNER_HEIGHT}px`,
      flexWrap: 'nowrap',
      minWidth: '0',
      overflow: 'hidden',
      boxSizing: 'border-box',
    })
    expect(screen.getByTestId('founding-member-text')).toHaveStyle({
      flex: '1 1 0%',
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
    expect(screen.getByTestId('founding-member-cta')).toHaveStyle({
      flex: '0 0 auto',
      minWidth: '0',
      maxWidth: '40%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
    expect(screen.getByTestId('founding-member-dismiss')).toHaveStyle({
      width: '22px',
      height: '22px',
      padding: '0',
    })
  })

  it('persists dismissal through a normal button click', () => {
    render(<FoundingMemberBanner />)

    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))

    expect(screen.queryByTestId('founding-member-banner')).not.toBeInTheDocument()
    expect(localStorage.getItem('founding-banner-dismissed')).toBe('1')
  })

  it('does not allow a responsive !important rule to re-enable wrapping', () => {
    const responsiveCss = readFileSync(join(process.cwd(), 'public/styles/responsive.css'), 'utf8')
    const declarations = Array.from(
      responsiveCss.matchAll(/\.founding-member-banner\s*\{([^}]*)\}/g),
      (match) => match[1]
    )

    expect(declarations).toEqual(
      expect.arrayContaining([expect.stringMatching(/flex-wrap:\s*nowrap\s*!important/i)])
    )
    expect(declarations.some((rule) => /flex-wrap:\s*wrap/i.test(rule))).toBe(false)
    expect(responsiveCss).toMatch(
      /\.founding-member-banner \.fm-cta\s*\{[^}]*min-height:\s*0\s*!important/i
    )
    expect(responsiveCss).toMatch(
      /\.founding-member-banner button\s*\{[^}]*min-height:\s*22px\s*!important/i
    )
  })
})
