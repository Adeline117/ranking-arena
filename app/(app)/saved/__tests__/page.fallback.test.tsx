import { render, screen } from '@testing-library/react'
import SavedPage from '../page'

jest.mock('../SavedHub', () => ({
  __esModule: true,
  default: () => {
    throw new Promise(() => undefined)
  },
}))

jest.mock('@/lib/i18n', () => ({
  t: () => 'Loading',
}))

describe('SavedPage fallback', () => {
  it('reserves the saved hub layout while search params hydrate', () => {
    const { container } = render(<SavedPage />)

    // Loading is announced once by the fallback container; the placeholder
    // blocks themselves are decorative.
    expect(screen.getByRole('status', { name: 'Loading' })).toBeVisible()
    const placeholders = container.querySelectorAll('.skeleton')
    expect(placeholders.length).toBeGreaterThan(5)
    expect(placeholders[0]).toBeVisible()
  })
})
