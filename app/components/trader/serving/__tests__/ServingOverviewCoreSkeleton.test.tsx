import { render, screen } from '@testing-library/react'
import ServingOverviewCoreSkeleton from '../ServingOverviewCoreSkeleton'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('ServingOverviewCoreSkeleton', () => {
  it('announces one loading state while keeping decorative skeletons hidden', () => {
    const { container } = render(<ServingOverviewCoreSkeleton />)

    const status = screen.getByRole('status', { name: 'loading' })
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveAttribute('aria-live', 'polite')

    const decoration = container.querySelector('[aria-hidden="true"]')
    expect(decoration).not.toBeNull()
    expect(decoration?.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
  })
})
