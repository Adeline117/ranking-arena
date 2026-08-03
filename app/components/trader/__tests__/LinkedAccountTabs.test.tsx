import React, { forwardRef } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      key === 'linkedAccountAll'
        ? 'All accounts'
        : key === 'traderPrimaryAccount'
          ? 'Primary account'
          : key,
  }),
}))
jest.mock('@/app/components/ui/ExchangeLogo', () => ({
  __esModule: true,
  default: ({ exchange }: { exchange: string }) => <span data-exchange={exchange} />,
}))
jest.mock('@/lib/hooks/traderFetcher', () => ({ traderFetcher: jest.fn() }))
jest.mock('@/app/components/base', () => ({
  Box: forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Box(
    { children, ...props },
    ref
  ) {
    return (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  }),
  Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}))

import LinkedAccountTabs, { type LinkedAccount } from '../LinkedAccountTabs'

function account(platform: string, traderKey: string, isPrimary = false): LinkedAccount {
  return {
    id: `${platform}:${traderKey}`,
    platform,
    traderKey,
    handle: null,
    label: null,
    isPrimary,
    roi: null,
    pnl: null,
    arenaScore: null,
  }
}

function setMobile(matches: boolean) {
  window.matchMedia = jest.fn(
    () =>
      ({
        matches,
        media: '(max-width: 768px)',
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }) as MediaQueryList
  )
}

function renderTabs(accounts: LinkedAccount[], onAccountChange = jest.fn(), activeAccount = 'all') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    onAccountChange,
    ...render(
      <QueryClientProvider client={client}>
        <LinkedAccountTabs
          accounts={accounts}
          activeAccount={activeAccount}
          onAccountChange={onAccountChange}
        />
      </QueryClientProvider>
    ),
  }
}

describe('LinkedAccountTabs interactions', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: jest.fn(),
    })
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it('distinguishes same-exchange accounts and moves focus with arrow keys', () => {
    setMobile(false)
    const accounts = [account('bybit', 'desk-one', true), account('bybit', 'desk-two')]
    const { onAccountChange } = renderTabs(accounts)
    const tablist = screen.getByRole('radiogroup')
    const all = within(tablist).getByRole('radio', { name: /All accounts/ })

    expect(within(tablist).getByRole('radio', { name: /Bybit · desk-one/ })).toBeVisible()
    expect(within(tablist).getByRole('radio', { name: /Bybit · desk-two/ })).toBeVisible()

    all.focus()
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    expect(onAccountChange).toHaveBeenCalledWith('bybit:desk-one')
    expect(document.activeElement).toHaveAttribute('data-account-key', 'bybit:desk-one')
  })

  it('keeps mobile option clicks inside the dropdown and exposes menu state', () => {
    setMobile(true)
    const accounts = [
      account('bybit', 'primary', true),
      account('okx', 'second'),
      account('bitget', 'third'),
      account('gmx', 'fourth'),
    ]
    const { onAccountChange } = renderTabs(accounts)
    const trigger = screen.getByRole('button', { name: /All accounts 4/ })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const option = screen.getByRole('menuitemradio', { name: /okx/i })
    fireEvent.mouseDown(option)
    expect(screen.getByRole('menu')).toBeVisible()
    fireEvent.click(option)

    expect(onAccountChange).toHaveBeenCalledWith('okx:second')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('supports the complete mobile menu keyboard loop and restores trigger focus', () => {
    setMobile(true)
    renderTabs([
      account('bybit', 'primary', true),
      account('okx', 'second'),
      account('bitget', 'third'),
      account('gmx', 'fourth'),
    ])
    const trigger = screen.getByRole('button', { name: /All accounts 4/ })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const options = screen.getAllByRole('menuitemradio')
    expect(options[0]).toHaveFocus()
    fireEvent.keyDown(options[0], { key: 'ArrowDown' })
    expect(options[1]).toHaveFocus()
    fireEvent.keyDown(options[1], { key: 'End' })
    expect(options.at(-1)).toHaveFocus()
    fireEvent.keyDown(options.at(-1)!, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes the mobile dropdown on an outside pointer action', () => {
    setMobile(true)
    renderTabs([
      account('bybit', 'primary', true),
      account('okx', 'second'),
      account('bitget', 'third'),
      account('gmx', 'fourth'),
    ])
    const trigger = screen.getByRole('button', { name: /All accounts 4/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeVisible()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
