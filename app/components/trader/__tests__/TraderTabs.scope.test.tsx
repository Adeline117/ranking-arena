import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/base', () => ({
  Box: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function MockBox(
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

import TraderTabs from '../TraderTabs'

describe('TraderTabs account scope', () => {
  it('removes every hidden metric tab while retaining overview and social posts', () => {
    render(
      <TraderTabs
        activeTab="overview"
        onTabChange={jest.fn()}
        extraTabs={['posts']}
        hideTabs={['stats', 'portfolio']}
      />
    )

    expect(screen.getByRole('tab', { name: 'overview' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'posts' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'stats' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'portfolio' })).not.toBeInTheDocument()
  })

  it('keyboard navigation cannot enter a hidden tab', () => {
    const onTabChange = jest.fn()
    render(
      <TraderTabs
        activeTab="overview"
        onTabChange={onTabChange}
        extraTabs={['posts']}
        hideTabs={['stats', 'portfolio']}
      />
    )

    fireEvent.keyDown(screen.getByRole('tab', { name: 'overview' }), { key: 'ArrowRight' })
    expect(onTabChange).toHaveBeenCalledWith('posts')
  })
})
