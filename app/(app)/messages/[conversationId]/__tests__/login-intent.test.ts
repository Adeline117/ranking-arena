import { buildConversationLoginHref, buildConversationReturnPath } from '../login-intent'

describe('conversation login intent', () => {
  it('returns users to the exact conversation after login', () => {
    const conversationId = '54b0ab36-baa1-41cf-b9a8-8a776090f524'
    const returnPath = `/messages/${conversationId}`

    expect(buildConversationReturnPath(conversationId)).toBe(returnPath)
    expect(buildConversationLoginHref(conversationId)).toBe(
      `/login?returnUrl=${encodeURIComponent(returnPath)}`
    )
  })

  it('keeps reserved characters inside the conversation path segment', () => {
    const returnPath = buildConversationReturnPath('conversation/with?reserved#characters')

    expect(returnPath).toBe('/messages/conversation%2Fwith%3Freserved%23characters')
    expect(
      new URL(
        buildConversationLoginHref('conversation/with?reserved#characters'),
        'https://arena.test'
      ).searchParams.get('returnUrl')
    ).toBe(returnPath)
  })

  it('falls back to the direct-message inbox until the route param resolves', () => {
    expect(buildConversationReturnPath('')).toBe('/inbox?tab=messages&chat=direct')
    expect(buildConversationLoginHref('')).toBe(
      '/login?returnUrl=%2Finbox%3Ftab%3Dmessages%26chat%3Ddirect'
    )
  })
})
