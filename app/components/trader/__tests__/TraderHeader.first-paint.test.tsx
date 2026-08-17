import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('next/dynamic', () => () => () => null)

jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { getUser: jest.fn() } },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('../../base', () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({
    as: Component = 'span',
    children,
    ...props
  }: React.HTMLAttributes<HTMLElement> & { as?: keyof React.JSX.IntrinsicElements }) => (
    <Component {...props}>{children}</Component>
  ),
}))

jest.mock('../TraderHeaderAvatar', () => ({
  TraderHeaderAvatar: () => <div data-testid="trader-avatar" />,
}))

jest.mock('../TraderHeaderBadges', () => ({
  TraderHeaderBadges: () => null,
}))

jest.mock('../TraderHeaderActions', () => ({
  TraderHeaderActions: () => null,
}))

import TraderHeader from '../TraderHeader'

describe('TraderHeader first paint', () => {
  it('keeps the trader identity visible before hydration effects run', () => {
    const markup = renderToStaticMarkup(
      <TraderHeader handle="trader-one" displayName="Trader One" traderId="trader-1" />
    )

    expect(markup).toContain('Trader One')
    expect(markup).toContain('opacity:1')
    expect(markup).not.toContain('opacity:0')
  })
})
