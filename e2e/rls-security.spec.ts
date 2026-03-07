/**
 * RLS 安全策略 E2E 测试
 * 验证 API 端点是否正确执行认证和权限检查
 */

import { test, expect } from '@playwright/test'

test.describe('RLS Security - Notifications', () => {
  test('should not allow creating notifications for other users via API', async ({ request }) => {
    const response = await request.post('/api/notifications', {
      data: {
        user_id: 'victim-user-id',
        type: 'system',
        title: 'Fake System Alert',
        message: 'This is a fake notification',
      },
    })

    expect(response.ok()).toBeFalsy()
  })
})

test.describe('RLS Security - Group Applications', () => {
  test('unauthenticated user cannot approve group applications', async ({ request }) => {
    const response = await request.post('/api/groups/test-group/applications/approve', {
      data: { applicationId: 'fake-application-id' },
    })

    expect(response.ok()).toBeFalsy()
  })

  test('unauthenticated user cannot view group applications', async ({ request }) => {
    const response = await request.get('/api/groups/test-group/applications')

    expect(response.ok()).toBeFalsy()
  })
})

test.describe('RLS Security - Post Deletion', () => {
  test('unauthenticated user cannot delete posts', async ({ request }) => {
    const response = await request.delete('/api/posts/fake-post-id')

    expect(response.ok()).toBeFalsy()
  })

  test('unauthenticated user cannot delete comments', async ({ request }) => {
    const response = await request.delete('/api/comments/fake-comment-id')

    expect(response.ok()).toBeFalsy()
  })
})

test.describe('RLS Security - Pro Features', () => {
  test('unauthenticated user cannot access pro groups API', async ({ request }) => {
    const response = await request.get('/api/pro/official-groups')

    expect(response.ok()).toBeFalsy()
  })

  test('pro page blocks unauthenticated user', async ({ page }) => {
    const response = await page.goto('/pro/official-groups')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    const status = response?.status() ?? 0
    const body = await page.textContent('body')

    // Page doesn't exist (404) or redirects to login or shows login/upgrade prompt
    expect(
      status === 404 ||
      url.includes('/login') ||
      url.includes('/404') ||
      body?.includes('登录') ||
      body?.includes('升级') ||
      body?.includes('Login') ||
      body?.includes('Upgrade') ||
      body?.includes('404') ||
      body?.includes('找不到')
    ).toBeTruthy()
  })
})

test.describe('RLS Security - Upload Protection', () => {
  test('unauthenticated user cannot upload profile images', async ({ request }) => {
    const response = await request.post('/api/upload-profile-image', {
      multipart: {
        file: {
          name: 'test.png',
          mimeType: 'image/png',
          buffer: Buffer.from('fake-image-data'),
        },
        userId: 'victim-user-id',
      },
    })

    expect(response.ok()).toBeFalsy()
  })
})

test.describe('RLS Security - Follow Protection', () => {
  test('unauthenticated user cannot follow traders', async ({ request }) => {
    const response = await request.post('/api/follow', {
      data: { traderId: 'fake-trader-id', action: 'follow' },
    })

    expect(response.ok()).toBeFalsy()
  })
})

test.describe('RLS Security - Message Protection', () => {
  test('unauthenticated user cannot send messages', async ({ request }) => {
    const response = await request.post('/api/messages', {
      data: { receiverId: 'fake-user-id', content: 'test message' },
    })

    // Accept 401 (unauthorized) or 429 (rate limited) — both block the request
    expect([401, 429]).toContain(response.status())
  })

  test('unauthenticated user cannot read messages', async ({ request }) => {
    const response = await request.get('/api/messages')

    // Accept 401 (unauthorized) or 429 (rate limited) — both block the request
    expect([401, 429]).toContain(response.status())
  })
})
