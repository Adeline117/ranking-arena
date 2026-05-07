const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ 
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGE_ERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE_ERROR: ' + msg.text()); });

  try {
    console.log('1. Loading /quiz...');
    await page.goto('https://www.arenafi.org/quiz', { waitUntil: 'networkidle', timeout: 30000 });

    console.log('2. Clicking Start...');
    await page.click('.quiz-start-btn');
    await page.waitForURL('**/quiz/questions**', { timeout: 10000 });

    console.log('3. Answering 15 questions (mobile)...');
    for (let i = 0; i < 15; i++) {
      await page.waitForSelector('.quiz-option-btn, .quiz-yesno-btn', { timeout: 5000 });
      const btns = await page.$$('.quiz-option-btn, .quiz-yesno-btn');
      const idx = Math.floor(Math.random() * btns.length);
      await btns[idx].click();
      await page.waitForTimeout(500);
    }
    console.log('   All 15 answered');

    await page.waitForTimeout(500);
    const submitReady = await page.$('.quiz-submit-btn[data-ready="true"]');
    const submitAny = await page.$('.quiz-submit-btn');
    if (submitReady) {
      console.log('4. Submit READY, clicking...');
      await submitReady.click();
    } else if (submitAny) {
      const text = await submitAny.textContent();
      const ready = await submitAny.getAttribute('data-ready');
      console.log('4. Submit NOT ready: ready=' + ready + ' text="' + text + '"');
      await page.screenshot({ path: '/tmp/quiz-mobile-stuck.png', fullPage: true });
    } else {
      console.log('4. No submit button found');
      await page.screenshot({ path: '/tmp/quiz-mobile-nosubmit.png', fullPage: true });
    }

    console.log('5. Waiting for result...');
    try {
      await page.waitForURL('**/quiz/result**', { timeout: 25000 });
      await page.waitForTimeout(5000);
      const bodyText = await page.textContent('body');
      if (bodyText.includes('Something went wrong') || bodyText.includes('Application error')) {
        console.log('   RESULT PAGE ERROR!');
      } else {
        console.log('   Result page OK, URL: ' + page.url());
      }
      await page.screenshot({ path: '/tmp/quiz-mobile-result.png', fullPage: true });
    } catch {
      console.log('   TIMEOUT - URL: ' + page.url());
      const bodyText = await page.textContent('body');
      console.log('   Body: ' + bodyText.slice(0, 300));
      await page.screenshot({ path: '/tmp/quiz-mobile-timeout.png', fullPage: true });
    }
  } catch (e) {
    console.log('FATAL: ' + e.message);
    await page.screenshot({ path: '/tmp/quiz-mobile-fatal.png' });
  }

  if (errors.length) {
    console.log('\n--- Browser Errors (' + errors.length + ') ---');
    errors.forEach(e => console.log(e));
  } else {
    console.log('\nNo browser errors');
  }
  await browser.close();
})();
