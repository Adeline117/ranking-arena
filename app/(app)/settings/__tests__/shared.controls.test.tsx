import { fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'

import { NotificationsSection } from '../components/NotificationsSection'
import { RadioOption, ToggleSwitch } from '../components/shared'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/notifications/PushNotificationToggle', () => ({
  PushNotificationToggle: () => null,
}))

jest.mock('@/lib/utils/haptics', () => ({
  isHapticSupported: () => true,
  haptic: jest.fn(),
  setHapticsEnabled: jest.fn(),
}))

const notificationProps = {
  notifyFollow: true,
  setNotifyFollow: jest.fn(),
  notifyLike: false,
  setNotifyLike: jest.fn(),
  notifyComment: true,
  setNotifyComment: jest.fn(),
  notifyMention: true,
  setNotifyMention: jest.fn(),
  notifyMessage: false,
  setNotifyMessage: jest.fn(),
  notifyTraderEvents: true,
  setNotifyTraderEvents: jest.fn(),
  hapticEnabled: false,
  setHapticEnabled: jest.fn(),
  emailDigest: 'weekly' as const,
  onEmailDigestChange: jest.fn(),
}

describe('settings shared controls', () => {
  it('keeps a 44px switch target around the compact visual track', () => {
    const onChange = jest.fn()
    const { container } = render(
      <ToggleSwitch checked ariaLabel="Activity notifications" onChange={onChange} />
    )

    const control = screen.getByRole('switch', { name: 'Activity notifications' })
    expect(control).toHaveAttribute('type', 'button')
    expect(control).toHaveStyle({ width: '48px', height: '44px', minHeight: '44px' })

    const track = container.querySelector('.settings-toggle-switch-track')
    expect(track).toHaveAttribute('aria-hidden', 'true')
    expect(track).toHaveStyle({ width: '48px', height: '26px', top: '9px' })

    fireEvent.click(control)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('uses the radio row as the touch target without inflating the native control', () => {
    const onChange = jest.fn()
    render(
      <RadioOption
        name="digest"
        value="weekly"
        currentValue="none"
        label="Weekly digest"
        description="Once a week"
        onChange={onChange}
      />
    )

    const radio = screen.getByRole('radio', { name: 'Weekly digest Once a week' })
    expect(radio).toHaveStyle({
      width: '16px',
      height: '16px',
      minWidth: '16px',
      minHeight: '16px',
    })
    expect(radio.closest('label')).toHaveStyle({ minHeight: '44px' })

    fireEvent.click(radio)
    expect(onChange).toHaveBeenCalledWith('weekly')
  })

  it('keeps the haptic capability branch stable during server rendering', () => {
    const serverMarkup = renderToStaticMarkup(<NotificationsSection {...notificationProps} />)
    expect(serverMarkup).not.toContain('hapticFeedbackTitle')

    render(<NotificationsSection {...notificationProps} />)
    expect(screen.getByText('hapticFeedbackTitle')).toBeInTheDocument()
  })
})
