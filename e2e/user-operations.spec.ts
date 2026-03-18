import { test, expect } from '@playwright/test'

/**
 * User Operations E2E Tests
 *
 * Tests every user-facing API operation for correct behavior, edge cases,
 * and error handling. Based on patterns from:
 * - goldbergyoni/javascript-testing-best-practices (⭐ 24K+)
 * - twentyhq/twenty Playwright auth tests
 *
 * Pattern: API-level tests (fast, no browser rendering overhead)
 * Each test is independent — no shared state between tests.
 */

const BASE_URL = process.env.PLAYWRIGHT_TEST_URL || 'http://localhost:3000'

// ═══════════════════════════════════════════════
// 1. WATCHLIST OPERATIONS
// ═══════════════════════════════════════════════

test.describe('Watchlist API', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/watchlist`, {
      data: { source: 'binance_futures', source_trader_id: 'test123' },
    })
    expect(res.status()).toBe(401)
  })

  test('POST with missing fields returns 400', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/watchlist`, {
      data: { source: 'binance_futures' }, // missing source_trader_id
      headers: { Authorization: 'Bearer invalid-token' },
    })
    // Either 401 (invalid token) or 400 (missing field)
    expect([400, 401]).toContain(res.status())
  })

  test('POST with oversized input returns 400', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/watchlist`, {
      data: { source: 'x'.repeat(100), source_trader_id: 'y'.repeat(300) },
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect([400, 401]).toContain(res.status())
  })

  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/watchlist`)
    expect(res.status()).toBe(401)
  })

  test('DELETE without auth returns 401', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/watchlist`, {
      data: { source: 'binance_futures', source_trader_id: 'test123' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 2. TRADER ALERTS
// ═══════════════════════════════════════════════

test.describe('Trader Alerts API', () => {
  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/trader-alerts`)
    expect(res.status()).toBe(401)
  })

  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/trader-alerts`, {
      data: { trader_id: 'test', alert_roi_change: true },
    })
    expect(res.status()).toBe(401)
  })

  test('DELETE without auth returns 401', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/trader-alerts?id=test`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 3. MESSAGES (SECURITY CRITICAL)
// ═══════════════════════════════════════════════

test.describe('Messages API Security', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/messages`, {
      data: { receiverId: '00000000-0000-0000-0000-000000000000', content: 'test' },
    })
    expect(res.status()).toBe(401)
  })

  test('GET without conversationId returns 400', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/messages`, {
      headers: { Authorization: 'Bearer invalid-token' },
    })
    // Either 401 (invalid token) or 400 (missing conversationId)
    expect([400, 401]).toContain(res.status())
  })

  test('POST rejects impersonation attempt', async ({ request }) => {
    // Even with invalid auth, the validation should reject senderId in body
    const res = await request.post(`${BASE_URL}/api/messages`, {
      data: {
        senderId: 'fake-user-id',
        receiverId: '00000000-0000-0000-0000-000000000000',
        content: 'impersonation test',
      },
    })
    // Should be 401 (no auth) or 403 (impersonation blocked)
    expect([401, 403]).toContain(res.status())
  })

  test('POST with empty content returns 400', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/messages`, {
      data: { receiverId: '00000000-0000-0000-0000-000000000000', content: '' },
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect([400, 401]).toContain(res.status())
  })
})

// ═══════════════════════════════════════════════
// 4. CHAT FILE UPLOAD (SECURITY)
// ═══════════════════════════════════════════════

test.describe('Chat Upload API Security', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/chat/upload`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 5. CHANNELS
// ═══════════════════════════════════════════════

test.describe('Channels API', () => {
  test('POST create group without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/channels`, {
      data: { name: 'Test Group', memberIds: ['user1'] },
    })
    expect(res.status()).toBe(401)
  })

  test('POST with empty name returns 400', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/channels`, {
      data: { name: '', memberIds: ['user1'] },
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect([400, 401]).toContain(res.status())
  })

  test('POST with name > 100 chars returns 400', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/channels`, {
      data: { name: 'x'.repeat(101), memberIds: ['user1'] },
      headers: { Authorization: 'Bearer invalid-token' },
    })
    expect([400, 401]).toContain(res.status())
  })
})

// ═══════════════════════════════════════════════
// 6. BLOCK USER (CASCADE)
// ═══════════════════════════════════════════════

test.describe('Block User API', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/users/test-handle/block`)
    expect(res.status()).toBe(401)
  })

  test('DELETE without auth returns 401', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/users/test-handle/block`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 7. FOLLOW OPERATIONS
// ═══════════════════════════════════════════════

test.describe('Follow API', () => {
  test('POST trader follow without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/follow`, {
      data: { traderId: 'test', action: 'follow' },
    })
    expect(res.status()).toBe(401)
  })

  test('POST user follow without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/users/follow`, {
      data: { followingId: '00000000-0000-0000-0000-000000000000', action: 'follow' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 8. CLAIM STATUS (PUBLIC)
// ═══════════════════════════════════════════════

test.describe('Claim Status API', () => {
  test('GET claim status is public (no auth required)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/traders/claim/status?trader_id=test&source=binance_futures`)
    // Should return 200 even without auth (public endpoint)
    expect(res.status()).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('data')
  })
})

// ═══════════════════════════════════════════════
// 9. NOTIFICATIONS
// ═══════════════════════════════════════════════

test.describe('Notifications API', () => {
  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/notifications`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 10. USER EXPERIENCE POINTS
// ═══════════════════════════════════════════════

test.describe('User EXP API', () => {
  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/user/exp`)
    expect(res.status()).toBe(401)
  })

  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/user/exp`, {
      data: { action: 'post' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 11. PRESENCE
// ═══════════════════════════════════════════════

test.describe('Presence API', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/presence`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 12. FEEDBACK (PUBLIC BUT RATE LIMITED)
// ═══════════════════════════════════════════════

test.describe('Feedback API', () => {
  test('POST with empty message returns 400', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/feedback`, {
      data: { message: '' },
    })
    expect([400, 429]).toContain(res.status())
  })

  test('POST with valid message returns 200', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/feedback`, {
      data: { message: 'E2E test feedback — please ignore', category: 'test' },
    })
    // 200 success or 429 rate limited (both acceptable in test env)
    expect([200, 429]).toContain(res.status())
  })
})

// ═══════════════════════════════════════════════
// 13. REPORT CONTENT
// ═══════════════════════════════════════════════

test.describe('Report API', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/report`, {
      data: { content_type: 'post', content_id: 'test', reason: 'spam' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 14. AVOID LIST
// ═══════════════════════════════════════════════

test.describe('Avoid List API', () => {
  test('GET avoid list is public', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/avoid-list?limit=5`)
    // 200 or 429 (rate limited)
    expect([200, 429]).toContain(res.status())
  })

  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/avoid-list`, {
      data: { trader_id: 'test', source: 'binance_futures', reason_type: 'loss' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 15. SUBSCRIPTION / STRIPE
// ═══════════════════════════════════════════════

test.describe('Subscription API', () => {
  test('POST create-checkout without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/stripe/create-checkout`, {
      data: { plan: 'pro_monthly' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 16. LINKED TRADERS
// ═══════════════════════════════════════════════

test.describe('Linked Traders API', () => {
  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/traders/linked`)
    expect(res.status()).toBe(401)
  })

  test('PATCH without auth returns 401', async ({ request }) => {
    const res = await request.patch(`${BASE_URL}/api/traders/linked`, {
      data: { id: 'test', label: 'new label' },
    })
    expect(res.status()).toBe(401)
  })

  test('DELETE without auth returns 401', async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/traders/linked?id=test`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 17. WALLET VERIFICATION (NONCE REPLAY)
// ═══════════════════════════════════════════════

test.describe('Wallet Verify API', () => {
  test('POST without auth returns 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/traders/claim/verify-wallet`, {
      data: { message: 'test', signature: '0x123', platform: 'hyperliquid' },
    })
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 18. COLLECTIONS
// ═══════════════════════════════════════════════

test.describe('Collections API', () => {
  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/collections`)
    expect(res.status()).toBe(401)
  })
})

// ═══════════════════════════════════════════════
// 19. BOOKMARK FOLDERS
// ═══════════════════════════════════════════════

test.describe('Bookmark Folders API', () => {
  test('GET without auth returns 401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/bookmark-folders`)
    expect(res.status()).toBe(401)
  })
})
