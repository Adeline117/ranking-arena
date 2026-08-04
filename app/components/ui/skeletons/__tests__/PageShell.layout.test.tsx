import { render } from '@testing-library/react'
import AppLoading from '@/app/(app)/loading'
import { PageShell } from '../PageShell'

function expectShellToUseTheExistingAppNav(container: HTMLElement) {
  const shell = container.firstElementChild

  expect(shell).toHaveAttribute('aria-busy', 'true')
  expect(shell).toHaveStyle({ minHeight: 'calc(100vh - 56px)' })
  expect(shell?.children).toHaveLength(1)
  expect(shell?.firstElementChild).toHaveStyle({ maxWidth: '1200px', margin: '0 auto' })
}

describe('app loading shell geometry', () => {
  it('does not duplicate the persistent TopNav in the route-group fallback', () => {
    const { container } = render(<AppLoading />)

    expectShellToUseTheExistingAppNav(container)
  })

  it('does not duplicate the persistent TopNav in page-specific skeletons', () => {
    const { container } = render(
      <PageShell>
        <div>Route-shaped skeleton</div>
      </PageShell>
    )

    expectShellToUseTheExistingAppNav(container)
  })
})
