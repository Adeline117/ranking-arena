const mockResendSend = jest.fn()

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockResendSend } })),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}))

describe('sendEmail', () => {
  beforeEach(() => {
    jest.resetModules()
    mockResendSend.mockReset().mockResolvedValue({ data: { id: 'email-1' }, error: null })
    process.env.RESEND_API_KEY = 'test-key'
  })

  it('passes a stable idempotency key to Resend when supplied', async () => {
    const { sendEmail } = await import('./email')

    await expect(
      sendEmail({
        to: 'qa@example.com',
        subject: 'Trader alert',
        html: '<p>Moved</p>',
        idempotencyKey: 'trader-alert/delivery-1',
      })
    ).resolves.toBe(true)

    expect(mockResendSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'qa@example.com' }), {
      idempotencyKey: 'trader-alert/delivery-1',
    })
  })

  it('keeps existing callers provider-compatible when no key is supplied', async () => {
    const { sendEmail } = await import('./email')

    await sendEmail({ to: 'qa@example.com', subject: 'Welcome', html: '<p>Hello</p>' })

    expect(mockResendSend).toHaveBeenCalledWith(expect.any(Object), undefined)
  })
})
