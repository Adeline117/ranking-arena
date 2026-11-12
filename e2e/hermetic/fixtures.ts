import { test as base, expect } from '@playwright/test'

/**
 * Every hermetic test runs with the browser cut off from the internet, and fails
 * on an uncaught page error. Both make silent breakage visible.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('**/*', (route) => {
        const { hostname } = new URL(route.request().url())
        return hostname === '127.0.0.1' || hostname === 'localhost'
          ? route.continue()
          : route.abort()
      })
      await use(errors)
      expect(errors, 'uncaught page errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
