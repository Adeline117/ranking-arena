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
    render(<SavedPage />)

    const placeholders = screen.getAllByLabelText('Loading')
    expect(placeholders.length).toBeGreaterThan(5)
    expect(placeholders[0]).toBeVisible()
  })
})
