/* eslint-disable no-console */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chromium } = require('@playwright/test')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()

  const errors = []
  page.on('pageerror', (e) => errors.push('PAGE_ERROR: ' + e.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('CONSOLE_ERROR: ' + msg.text())
  })

  try {
    console.log('1. Loading /quiz...')
    await page.goto('https://www.arenafi.org/quiz', { waitUntil: 'networkidle', timeout: 30000 })

    console.log('2. Clicking Start...')
    await page.click('.quiz-start-btn')
    await page.waitForURL('**/quiz/questions**', { timeout: 10000 })
    console.log('   URL: ' + page.url())

    console.log('3. Answering 15 questions...')
    for (let i = 0; i < 15; i++) {
      await page.waitForSelector('.quiz-option-btn, .quiz-yesno-btn', { timeout: 5000 })
      const btns = await page.$$('.quiz-option-btn, .quiz-yesno-btn')
      if (btns.length > 0) {
        await btns[0].click()
        console.log('   Q' + (i + 1) + ' answered')
        await page.waitForTimeout(500)
      } else {
        console.log('   Q' + (i + 1) + ' NO BUTTONS')
      }
    }

    await page.waitForTimeout(500)
    const submitBtn = await page.$('.quiz-submit-btn[data-ready="true"]')
    if (submitBtn) {
      console.log('4. Submit READY, clicking...')
      await submitBtn.click()
    } else {
      const anyBtn = await page.$('.quiz-submit-btn')
      const state = anyBtn ? await anyBtn.getAttribute('data-ready') : 'NOT_FOUND'
      const text = anyBtn ? await anyBtn.textContent() : 'N/A'
      console.log('4. Submit NOT ready: data-ready=' + state + ' text="' + text + '"')
      await page.screenshot({ path: '/tmp/quiz-stuck.png', fullPage: true })
    }

    console.log('5. Waiting for result...')
    try {
      await page.waitForURL('**/quiz/result**', { timeout: 20000 })
      await page.waitForTimeout(5000)
      await page.screenshot({ path: '/tmp/quiz-result.png', fullPage: true })

      const body = await page.textContent('body')
      if (body.includes('Something went wrong') || body.includes('Application error')) {
        console.log('   ERROR ON PAGE!')
        await page.screenshot({ path: '/tmp/quiz-error-page.png', fullPage: true })
      } else {
        console.log('   Result page OK, URL: ' + page.url())
      }
    } catch {
      console.log('   TIMEOUT - URL: ' + page.url())
      await page.screenshot({ path: '/tmp/quiz-timeout.png', fullPage: true })
    }
  } catch (e) {
    console.log('FATAL: ' + e.message)
    await page.screenshot({ path: '/tmp/quiz-fatal.png', fullPage: true })
  }

  if (errors.length) {
    console.log('\n--- Browser Errors ---')
    errors.forEach((e) => console.log(e))
  }

  await browser.close()
})()
