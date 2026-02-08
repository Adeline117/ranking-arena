import React from 'react'
import { render, screen } from '@testing-library/react'

// Mock LanguageProvider
jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => key,
  }),
}))

// Mock next/link
jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>
  MockLink.displayName = 'MockLink'
  return MockLink
})

import Footer from '../Footer'

describe('Footer', () => {
  it('renders without crashing', () => {
    const { container } = render(<Footer />)
    expect(container.querySelector('footer')).toBeInTheDocument()
  })

  it('contains navigation links', () => {
    render(<Footer />)
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
  })

  it('contains copyright year', () => {
    const { container } = render(<Footer />)
    const year = new Date().getFullYear().toString()
    expect(container.textContent).toContain(year)
  })

  it('contains social links', () => {
    render(<Footer />)
    const links = screen.getAllByRole('link')
    const socialHrefs = links.map(l => l.getAttribute('href')).filter(h => h?.includes('x.com') || h?.includes('discord') || h?.includes('t.me'))
    expect(socialHrefs.length).toBeGreaterThan(0)
  })
})
