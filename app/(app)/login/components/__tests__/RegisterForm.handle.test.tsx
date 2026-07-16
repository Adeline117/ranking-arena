import { fireEvent, render, screen } from '@testing-library/react'
import RegisterForm from '../RegisterForm'

const baseProps = {
  email: 'user@example.com',
  password: 'Password1',
  setPassword: jest.fn(),
  handle: 'valid_user',
  setHandle: jest.fn(),
  code: '123456',
  setCode: jest.fn(),
  codeSent: true,
  codeVerified: true,
  loading: false,
  sendingCode: false,
  countdown: 0,
  showPassword: false,
  setShowPassword: jest.fn(),
  touchedFields: { email: false, password: false, handle: false },
  markTouched: jest.fn(),
  onSendCode: jest.fn(),
  onVerifyCode: jest.fn(),
  onResendCode: jest.fn(),
  onSetPassword: jest.fn(),
  t: (key: string) => key,
}

describe('RegisterForm canonical handle behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps submission disabled for an invalid non-empty handle', () => {
    const view = render(<RegisterForm {...baseProps} handle="new.dotted.name" />)
    expect(screen.getByRole('button', { name: 'loginSetPassword' })).toBeDisabled()

    view.rerender(<RegisterForm {...baseProps} handle="交易员甲" />)
    expect(screen.getByRole('button', { name: 'loginSetPassword' })).not.toBeDisabled()
  })

  it('normalizes to NFC and truncates before committing input state', () => {
    const setHandle = jest.fn()
    render(<RegisterForm {...baseProps} setHandle={setHandle} />)

    fireEvent.change(screen.getByLabelText('loginHandle'), {
      target: { value: `${'界'.repeat(29)}\u306F\u3099tail` },
    })

    expect(setHandle).toHaveBeenCalledWith(`${'界'.repeat(29)}\u3070`)
  })

  it('exposes the required-handle error after the field is touched', () => {
    render(
      <RegisterForm
        {...baseProps}
        handle=""
        touchedFields={{ email: false, password: false, handle: true }}
      />
    )

    expect(screen.getByText('X - loginHandleTooShort')).toBeInTheDocument()
    expect(screen.getByLabelText('loginHandle')).toHaveAttribute('aria-invalid', 'true')
  })
})
