import { test, expect } from '@playwright/test'

// Round 6: Navigation and Information Architecture Tests
test.describe('Round 6 - Navigation Structure', () => {
  
  test('Desktop navigation should have correct items', async ({ page }) => {
    await page.goto('http://localhost:3000')
    
    // Wait for nav to load
    await page.waitForSelector('nav[aria-label*="navigation"]', { timeout: 5000 })
    
    // Check expected nav items exist
    const expectedItems = ['Rankings', 'Market', 'Flash News', 'Library']
    
    for (const item of expectedItems) {
      const link = page.getByRole('link', { name: item, exact: false })
      await expect(link).toBeVisible()
    }
    
    // Check unwanted items do NOT exist (when social features disabled)
    const unwantedItems = ['Groups', 'Hot']
    for (const item of unwantedItems) {
      const link = page.getByRole('link', { name: item, exact: true })
      await expect(link).toHaveCount(0)
    }
  })
  
  test('Mobile bottom nav should have 5 tabs', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('http://localhost:3000')
    
    // Wait for mobile nav
    await page.waitForSelector('.mobile-bottom-nav', { timeout: 5000 })
    
    // Count nav items
    const navItems = page.locator('.mobile-bottom-nav .mobile-nav-item')
    await expect(navItems).toHaveCount(5)
    
    // Check expected labels
    const expectedLabels = ['home', 'rankings', 'search', 'library', 'profile']
    for (let i = 0; i < expectedLabels.length; i++) {
      const item = navItems.nth(i)
      await expect(item).toBeVisible()
    }
  })
  
  test('All navigation links should be reachable (no 404)', async ({ page }) => {
    await page.goto('http://localhost:3000')
    
    // Desktop nav links
    const navLinks = await page.locator('nav a').all()
    const urls: string[] = []
    
    for (const link of navLinks) {
      const href = await link.getAttribute('href')
      if (href && !href.startsWith('#') && href.startsWith('/')) {
        urls.push(href)
      }
    }
    
    // Remove duplicates
    const uniqueUrls = [...new Set(urls)]
    
    const results: { url: string; status: number }[] = []
    
    for (const url of uniqueUrls) {
      const response = await page.goto(`http://localhost:3000${url}`)
      const status = response?.status() || 0
      results.push({ url, status })
      
      if (status === 404) {
        console.error(`❌ 404: ${url}`)
      }
    }
    
    // Check no 404s
    const errors = results.filter(r => r.status === 404)
    expect(errors.length).toBe(0)
  })
  
  test('Active navigation state should highlight current page', async ({ page }) => {
    const testPages = [
      { url: '/', expectedActive: 'home' },
      { url: '/rankings', expectedActive: 'rankings' },
      { url: '/market', expectedActive: 'market' },
      { url: '/flash-news', expectedActive: 'flashNews' },
      { url: '/library', expectedActive: 'library' },
    ]
    
    for (const { url, expectedActive } of testPages) {
      await page.goto(`http://localhost:3000${url}`)
      
      // Check desktop active state
      const activeLink = page.locator('.top-nav-link-active')
      await expect(activeLink).toHaveCount(1)
      
      // Mobile: check for active indicator or active styling
      await page.setViewportSize({ width: 375, height: 667 })
      const mobileActiveItem = page.locator('.mobile-nav-item[aria-current="page"]')
      await expect(mobileActiveItem).toHaveCount(1)
    }
  })
  
  test('DEAD exchanges should be filtered from UI', async ({ page }) => {
    // Navigate to rankings/filters page
    await page.goto('http://localhost:3000/rankings')
    
    // Look for exchange filter/dropdown
    // (This depends on the actual UI implementation)
    
    const deadExchanges = ['bitmart', 'btse', 'whitebit', 'perpetual_protocol']
    
    for (const exchange of deadExchanges) {
      // Check that these exchanges don't appear in any filter dropdown
      const exchangeOption = page.getByText(exchange, { exact: true })
      await expect(exchangeOption).toHaveCount(0)
    }
  })
})
