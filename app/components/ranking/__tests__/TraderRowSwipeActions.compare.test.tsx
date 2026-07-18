import { fireEvent, render, screen } from '@testing-library/react'

const mockShowToast = jest.fn()

jest.mock('@/lib/i18n', () => ({
  t: (key: string) =>
    (
      ({
        compare: 'Compare',
        share: 'Share',
        compareListFull: 'Compare list full (max 10)',
      }) as Record<string, string>
    )[key] ?? key,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

import { TraderRowSwipeActions } from '../TraderRowSwipeActions'

describe('TraderRowSwipeActions compare feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('warns when the row store callback rejects a full-list add', () => {
    const onCompareToggle = jest.fn(() => false)
    render(
      <TraderRowSwipeActions
        onCompareToggle={onCompareToggle}
        shareUrl="/trader/trader-1"
        displayName="Trader One"
      >
        <div>Trader row</div>
      </TraderRowSwipeActions>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))

    expect(onCompareToggle).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledWith('Compare list full (max 10)', 'warning')
  })

  it('does not show a failure toast when the compare state changes', () => {
    const onCompareToggle = jest.fn(() => true)
    render(
      <TraderRowSwipeActions
        onCompareToggle={onCompareToggle}
        shareUrl="/trader/trader-1"
        displayName="Trader One"
      >
        <div>Trader row</div>
      </TraderRowSwipeActions>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))

    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
