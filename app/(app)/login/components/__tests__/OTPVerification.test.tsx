import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import OTPVerification from '../OTPVerification'

jest.mock('../loginHelpers', () => ({ Spinner: () => null }))

function Harness({
  onVerify,
  initialCode = '',
  loading = false,
}: {
  onVerify: jest.Mock
  initialCode?: string
  loading?: boolean
}) {
  const [code, setCode] = useState(initialCode)
  return (
    <>
      <OTPVerification
        code={code}
        setCode={setCode}
        countdown={0}
        loading={loading}
        sendingCode={false}
        email="a@example.test"
        onVerify={onVerify}
        onResend={jest.fn()}
        t={(k) => k}
      />
      <output data-testid="code">{code}</output>
      <button onClick={() => setCode('')}>reset</button>
    </>
  )
}

const box = (i: number) =>
  screen.getByLabelText(`loginVerificationCode ${i + 1}`) as HTMLInputElement

describe('OTPVerification', () => {
  it('lets the first box accept a full autofilled code and spreads it', () => {
    const onVerify = jest.fn()
    render(<Harness onVerify={onVerify} />)

    expect(box(0).maxLength).toBe(6)
    expect(box(0).getAttribute('autocomplete')).toBe('one-time-code')
    expect(box(1).maxLength).toBe(1)

    fireEvent.change(box(0), { target: { value: '123456' } })
    expect(screen.getByTestId('code').textContent).toBe('123456')
    expect([0, 1, 2, 3, 4, 5].map((i) => box(i).value).join('')).toBe('123456')
    expect(onVerify).toHaveBeenCalledTimes(1)
  })

  it('spreads a pasted code from the box it lands in and auto-submits once', () => {
    const onVerify = jest.fn()
    render(<Harness onVerify={onVerify} />)
    fireEvent.paste(box(0), { clipboardData: { getData: () => 'code: 654 321' } })
    expect(screen.getByTestId('code').textContent).toBe('654321')
    expect(onVerify).toHaveBeenCalledTimes(1)
  })

  it('typing over a filled first box replaces the digit instead of shifting', () => {
    render(<Harness onVerify={jest.fn()} />)
    fireEvent.change(box(0), { target: { value: '1' } })
    fireEvent.change(box(0), { target: { value: '17' } })
    expect(box(0).value).toBe('7')
    expect(box(1).value).toBe('')
  })

  it('backspace on an empty box clears and focuses the previous one', () => {
    render(<Harness onVerify={jest.fn()} />)
    fireEvent.change(box(0), { target: { value: '1' } })
    fireEvent.change(box(1), { target: { value: '2' } })
    fireEvent.keyDown(box(2), { key: 'Backspace' })
    expect(box(1).value).toBe('')
    expect(document.activeElement).toBe(box(1))
    expect(screen.getByTestId('code').textContent).toBe('1')
  })

  it('clears every box when the parent resets the code and can auto-submit again', () => {
    const onVerify = jest.fn()
    render(<Harness onVerify={onVerify} />)
    fireEvent.change(box(0), { target: { value: '111111' } })
    fireEvent.click(screen.getByText('reset'))
    expect([0, 1, 2, 3, 4, 5].every((i) => box(i).value === '')).toBe(true)
    fireEvent.change(box(0), { target: { value: '222222' } })
    expect(onVerify).toHaveBeenCalledTimes(2)
  })
})
