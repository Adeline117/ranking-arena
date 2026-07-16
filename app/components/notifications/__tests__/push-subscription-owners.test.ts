import { isPushSubscriptionOwnedBy, setPushSubscriptionOwner } from '../push-subscription-owners'

describe('push subscription owner registry', () => {
  beforeEach(() => window.localStorage.clear())

  it('tracks one browser endpoint for multiple users independently', () => {
    expect(setPushSubscriptionOwner(localStorage, 'https://push.test/one', 'user-a', true)).toBe(
      true
    )
    expect(setPushSubscriptionOwner(localStorage, 'https://push.test/one', 'user-b', true)).toBe(
      true
    )

    expect(isPushSubscriptionOwnedBy(localStorage, 'https://push.test/one', 'user-a')).toBe(true)
    expect(isPushSubscriptionOwnedBy(localStorage, 'https://push.test/one', 'user-b')).toBe(true)

    setPushSubscriptionOwner(localStorage, 'https://push.test/one', 'user-b', false)
    expect(isPushSubscriptionOwnedBy(localStorage, 'https://push.test/one', 'user-a')).toBe(true)
    expect(isPushSubscriptionOwnedBy(localStorage, 'https://push.test/one', 'user-b')).toBe(false)
  })

  it('fails closed for malformed or inaccessible storage', () => {
    localStorage.setItem('arena:push-subscription-owners:v1', '{not-json')
    expect(isPushSubscriptionOwnedBy(localStorage, 'https://push.test/one', 'user-a')).toBe(false)

    const unavailable = {
      getItem: () => {
        throw new Error('storage denied')
      },
      setItem: () => {
        throw new Error('storage denied')
      },
    }
    expect(isPushSubscriptionOwnedBy(unavailable, 'https://push.test/one', 'user-a')).toBe(false)
    expect(setPushSubscriptionOwner(unavailable, 'https://push.test/one', 'user-a', true)).toBe(
      false
    )
  })
})
