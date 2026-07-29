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
      signal: expect.any(AbortSignal),
    })
  })

  it('bounds provider requests even when no idempotency key is supplied', async () => {
    const { sendEmail } = await import('./email')

    await sendEmail({ to: 'qa@example.com', subject: 'Welcome', html: '<p>Hello</p>' })

    expect(mockResendSend).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: undefined,
      signal: expect.any(AbortSignal),
    })
  })

  it('returns false when Resend resolves an API error', async () => {
    mockResendSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', message: 'invalid recipient' },
    })
    const { sendEmail } = await import('./email')

    await expect(
      sendEmail({ to: 'bad@example.com', subject: 'Welcome', html: '<p>Hello</p>' })
    ).resolves.toBe(false)
  })

  it('aborts a provider request at the caller timeout', async () => {
    mockResendSend.mockImplementationOnce(
      (_payload: unknown, requestOptions: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          requestOptions.signal.addEventListener(
            'abort',
            () =>
              resolve({
                data: null,
                error: { name: 'application_error', message: 'request aborted' },
              }),
            { once: true }
          )
        })
    )
    const { sendEmail } = await import('./email')

    await expect(
      sendEmail({
        to: 'slow@example.com',
        subject: 'Welcome',
        html: '<p>Hello</p>',
        timeoutMs: 5,
      })
    ).resolves.toBe(false)

    const requestOptions = mockResendSend.mock.calls[0][1] as { signal: AbortSignal }
    expect(requestOptions.signal.aborted).toBe(true)
  })
})
