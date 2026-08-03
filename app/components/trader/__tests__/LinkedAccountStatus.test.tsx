import { render, screen } from '@testing-library/react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/base', () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}))

import LinkedAccountStatus from '../LinkedAccountStatus'

describe('LinkedAccountStatus', () => {
  it('announces live membership verification without claiming an empty relation', () => {
    render(<LinkedAccountStatus isLoading error={null} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'checking')
    expect(screen.getByText('linkedAccountsChecking')).toBeInTheDocument()
  })

  it('announces unavailable membership instead of rendering it as no accounts', () => {
    render(<LinkedAccountStatus isLoading={false} error={new Error('offline')} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'unavailable')
    expect(screen.getByText('linkedAccountsUnavailable')).toBeInTheDocument()
  })

  it('renders nothing after an exact membership response settles', () => {
    const { container } = render(<LinkedAccountStatus isLoading={false} error={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
