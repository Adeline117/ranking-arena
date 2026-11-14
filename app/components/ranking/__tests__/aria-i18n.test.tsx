import { act, fireEvent, render, screen } from '@testing-library/react'
import ScoreMiniBar from '../ScoreMiniBar'
import { CopyButton } from '../HeroSection'
import { setLanguage } from '@/lib/i18n'

/** P2-14: ranking aria labels come from the dictionary in every language. */
describe('ranking aria labels are localized', () => {
  afterEach(() => {
    act(() => setLanguage('en'))
  })

  it('ScoreMiniBar default label follows the active language', () => {
    const { unmount } = render(<ScoreMiniBar score={72.4} />)
    expect(screen.getByRole('img')).toHaveAccessibleName('Arena Score 72 of 100')
    unmount()

    act(() => setLanguage('zh'))
    render(<ScoreMiniBar score={72.4} />)
    expect(screen.getByRole('img')).toHaveAccessibleName('Arena 评分 72（满分 100）')
  })

  it('CopyButton labels (copy / copied) are translated', async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } })
    act(() => setLanguage('zh'))
    render(<CopyButton text="0xabc" />)
    const button = screen.getByRole('button', { name: '复制交易员 ID' })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })
})
