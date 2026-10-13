import { portalErrorKey } from '../SubscriptionManagement'

describe('portalErrorKey', () => {
  it('maps only 503 to the not-configured copy', () => {
    expect(portalErrorKey(503)).toBe('paymentSystemComingSoon')
  })
  it('maps 401 to a session-expired message', () => {
    expect(portalErrorKey(401)).toBe('sessionExpired')
  })
  it.each([400, 429, 500])('maps %s to a generic retry message', (status) => {
    expect(portalErrorKey(status)).toBe('operationFailedTryAgain')
  })
})
