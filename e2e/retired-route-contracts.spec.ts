import { expect, test } from '@playwright/test'

test.describe('retired page contracts', () => {
  for (const path of ['/rankings/bots', '/bot/legacy-id']) {
    test(`${path} permanently redirects to home`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 })

      expect(response.status()).toBe(308)
      expect(response.headers().location).toBe('/')
    })
  }

  for (const path of ['/library', '/competitions']) {
    test(`${path} remains removed`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 })

      expect(response.status()).toBe(404)
    })
  }
})
