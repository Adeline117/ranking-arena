// Intercept network requests from Aevo copy-trading page
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const page = await browser.newPage();

const capturedRequests = [];

await page.setRequestInterception(true);

page.on('request', (request) => {
  const url = request.url();
  if (url.includes('aevo.xyz') || url.includes('api.')) {
    capturedRequests.push({ url, method: request.method() });
  }
  request.continue();
});

page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('aevo.xyz') && (url.includes('copy') || url.includes('trader') || url.includes('leader') || url.includes('stat') || url.includes('account'))) {
    try {
      const text = await response.text();
      console.log(`\n=== RESPONSE: ${url} ===`);
      console.log(text.substring(0, 500));
    } catch(e) {}
  }
});

console.log('Navigating to copy-trading page...');
try {
  await page.goto('https://app.aevo.xyz/copy-trading', { 
    waitUntil: 'networkidle2',
    timeout: 30000
  });
} catch (e) {
  console.log('Navigation timeout, that is OK');
}

// Wait a bit more to capture delayed requests
await new Promise(r => setTimeout(r, 5000));

console.log('\n=== ALL CAPTURED REQUESTS ===');
for (const req of capturedRequests) {
  if (req.url.includes('aevo')) {
    console.log(`${req.method} ${req.url}`);
  }
}

await browser.close();
