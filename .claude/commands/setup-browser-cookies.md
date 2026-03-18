---
description: Import real browser cookies into headless Playwright session for authenticated QA testing
---

# Setup Browser Cookies

Import cookies from a real browser into the headless Playwright session so you can QA test authenticated pages (admin, pro features, user profile).

## Process

### Step 1: Export cookies from real browser

The user needs to have cookies available. Check for common cookie export locations:

```bash
# Chrome cookies (macOS)
ls ~/Library/Application\ Support/Google/Chrome/Default/Cookies 2>/dev/null

# Arc cookies (macOS)
ls ~/Library/Application\ Support/Arc/User\ Data/Default/Cookies 2>/dev/null
```

### Step 2: Create Playwright storage state

Ask the user to sign into Arena at localhost:3000 in their real browser, then:

```javascript
// save-auth-state.mjs
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: false }) // visible browser
const context = await browser.newContext()
const page = await context.newPage()

await page.goto('http://localhost:3000/login')
console.log('Sign in manually, then press Enter in the terminal...')
await new Promise(r => process.stdin.once('data', r))

// Save auth state
await context.storageState({ path: '/tmp/arena-auth-state.json' })
console.log('Auth state saved to /tmp/arena-auth-state.json')
await browser.close()
```

### Step 3: Use in QA tests

```javascript
// Load saved auth state
const context = await browser.newContext({
  storageState: '/tmp/arena-auth-state.json'
})
const page = await context.newPage()
await page.goto('http://localhost:3000/admin')
// Now authenticated!
```

### Step 4: Verify

```bash
# Check if auth state file exists and is valid
cat /tmp/arena-auth-state.json | head -5
```

Note: Auth state expires. Re-run this command if tests show unauthenticated pages.
