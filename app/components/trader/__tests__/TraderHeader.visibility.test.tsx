import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => () => null,
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { getUser: jest.fn() } },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/app/components/ui/ProBadge', () => ({
  ProBadgeOverlay: () => null,
}))

jest.mock('../TraderHeaderBadges', () => ({
  TraderHeaderBadges: () => null,
}))

jest.mock('../TraderHeaderActions', () => ({
  TraderHeaderActions: () => null,
}))

import TraderHeader from '../TraderHeader'
import { TraderHeaderAvatar } from '../TraderHeaderAvatar'

describe('TraderHeader first render', () => {
  it('keeps a claimed and bound trader header visible in server markup', () => {
    const markup = renderToStaticMarkup(
      <TraderHeader
        handle="claimed_trader"
        displayName="Claimed Bound Trader"
        traderId="trader-1"
        currentUserId={null}
        isRegistered
        isVerifiedTrader
        isAuthorized
        claimedBio="Verified profile"
      />
    )
    const host = document.createElement('div')
    host.innerHTML = markup
    const header = host.querySelector<HTMLElement>('.profile-header')

    expect(header).not.toBeNull()
    expect(header).toHaveTextContent('Claimed Bound Trader')
    expect(header?.style.opacity).toBe('')
    expect(header?.style.transition).not.toContain('opacity')
  })

  it('backs opaque cover text with a deterministic contrast surface in server markup', () => {
    const markup = renderToStaticMarkup(
      <TraderHeader
        handle="claimed_trader"
        displayName="Claimed Bound Trader"
        traderId="trader-1"
        currentUserId={null}
        isRegistered
        coverUrl="https://cdn.example.com/white-cover.jpg"
        linkedAccountCount={2}
        claimedBio="Readable profile"
        lastUpdated="2026-08-08T00:00:00.000Z"
      />
    )
    const host = document.createElement('div')
    host.innerHTML = markup
    const scrim = host.querySelector<HTMLElement>('.trader-cover-scrim')
    const textNodes = Array.from(host.querySelectorAll<HTMLElement>('p'))
    const subtitle = textNodes.find((node) => node.textContent?.includes('verifiedAccounts'))
    const updated = textNodes.find((node) => node.textContent?.includes('updated'))
    const bio = textNodes.find((node) => node.textContent === 'Readable profile')

    expect(scrim).toHaveStyle({ background: 'var(--color-backdrop-heavy)' })
    for (const node of [subtitle, updated, bio]) {
      expect(node).toHaveStyle({ color: '#FFFFFF', textShadow: 'var(--text-shadow-md)' })
    }
  })
})

describe('TraderHeaderAvatar semantics', () => {
  it('renders identity content without pretending to be an action', () => {
    const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    const { container } = render(
      <TraderHeaderAvatar traderId="trader-1" handle="Static Trader" proBadgeTier={null} />
    )
    const avatar = container.querySelector<HTMLElement>('.profile-header-avatar')
    const wrapper = avatar?.parentElement

    expect(avatar).not.toBeNull()
    expect(wrapper?.tagName).toBe('DIV')
    expect(wrapper).not.toHaveAttribute('role', 'button')
    expect(wrapper).not.toHaveAttribute('tabindex')
    expect(wrapper).not.toHaveStyle({ cursor: 'pointer' })
    expect(avatar).not.toHaveStyle({ cursor: 'pointer' })
    expect(avatar?.style.transform).toBe('')

    const border = avatar?.style.border
    const boxShadow = avatar?.style.boxShadow
    if (wrapper) {
      fireEvent.click(wrapper)
      fireEvent.keyDown(wrapper, { key: 'Enter' })
      fireEvent.mouseEnter(wrapper)
      fireEvent.mouseLeave(wrapper)
    }

    expect(scrollTo).not.toHaveBeenCalled()
    expect(avatar?.style.border).toBe(border)
    expect(avatar?.style.boxShadow).toBe(boxShadow)

    scrollTo.mockRestore()
  })
})
