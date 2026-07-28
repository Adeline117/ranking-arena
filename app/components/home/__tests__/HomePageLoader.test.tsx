import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentType, ReactNode } from 'react'
import dynamic from 'next/dynamic'
import HomePageLoader from '../HomePageLoader'

type DynamicModule = { default: ComponentType<Record<string, unknown>> }
type DynamicLoader = () => Promise<DynamicModule>
type DynamicOptions = { ssr?: boolean; loading?: () => ReactNode }

jest.mock('../HomeInteractiveRoot', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: jest.fn(
    (_loader: DynamicLoader, _options: DynamicOptions) =>
      function DeferredHomeInteractiveRoot(props: Record<string, unknown>) {
        return (
          <div
            data-testid="home-interactive-root"
            data-initial-is-stale={String(props.initialIsStale)}
            data-initial-total-count={String(props.initialTotalCount)}
          />
        )
      }
  ),
}))

describe('HomePageLoader async boundary', () => {
  it('registers one client-only dynamic import for HomeInteractiveRoot', async () => {
    const mockDynamic = jest.mocked(dynamic)
    expect(mockDynamic).toHaveBeenCalledTimes(1)

    const [loader, options] = mockDynamic.mock.calls[0] as unknown as [
      DynamicLoader,
      DynamicOptions,
    ]
    expect(options).toEqual(
      expect.objectContaining({
        ssr: false,
        loading: expect.any(Function),
      })
    )

    const [loadedModule, mockedModule] = await Promise.all([
      loader(),
      import('../HomeInteractiveRoot'),
    ])
    expect(loadedModule.default).toBe(mockedModule.default)
  })

  it('keeps the SSR shell active before effects and switches to the interactive root after hydration', async () => {
    const serverMarkup = renderToStaticMarkup(
      <HomePageLoader initialIsStale initialTotalCount={321} />
    )

    expect(serverMarkup).toContain('ssr-loading-bar')
    expect(serverMarkup).not.toContain('home-interactive-root')

    const { container } = render(<HomePageLoader initialIsStale initialTotalCount={321} />)
    const interactiveRoot = await screen.findByTestId('home-interactive-root')

    expect(interactiveRoot).toHaveAttribute('data-initial-is-stale', 'true')
    expect(interactiveRoot).toHaveAttribute('data-initial-total-count', '321')
    expect(container.querySelector('.ssr-loading-bar')).not.toBeInTheDocument()
  })

  it('does not statically own the provider graph', () => {
    const loaderSource = readFileSync(
      join(process.cwd(), 'app/components/home/HomePageLoader.tsx'),
      'utf8'
    )
    const rootSource = readFileSync(
      join(process.cwd(), 'app/components/home/HomeInteractiveRoot.tsx'),
      'utf8'
    )

    expect(loaderSource).not.toMatch(/^import .*Providers/m)
    expect(loaderSource).not.toContain("import('./HomePage')")
    expect(loaderSource).not.toContain("import('./WelcomeBanner')")
    expect(loaderSource.match(/\bdynamic\s*\(/g)).toHaveLength(1)
    expect(loaderSource).toContain("dynamic(() => import('./HomeInteractiveRoot')")

    expect(rootSource).toContain("import Providers from '../Providers'")
    expect(rootSource).toContain("import HomePage from './HomePage'")
    expect(rootSource).toContain("import WelcomeBanner from './WelcomeBanner'")
  })
})
