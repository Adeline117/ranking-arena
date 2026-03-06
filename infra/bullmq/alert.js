// Telegram alerting module
const https = require('https');
const { execSync } = require('child_process');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '5646617467';

// Dedup: don't send same alert within 30 min
const alertHistory = new Map();
const DEDUP_MS = 30 * 60 * 1000;

function canSend(key) {
  const last = alertHistory.get(key);
  if (last && Date.now() - last < DEDUP_MS) return false;
  alertHistory.set(key, Date.now());
  return true;
}

async function sendTelegram(text) {
  if (!BOT_TOKEN) {
    console.log(`[ALERT-NO-TOKEN] ${text}`);
    return;
  }

  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`Telegram API error: ${res.statusCode} ${data}`);
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function alertFetcherDown(jobName, failures, lastError) {
  const key = `fetcher-down:${jobName}`;
  if (!canSend(key)) return;
  await sendTelegram(
    `🚨 <b>Arena Fetcher Down</b>\n\n` +
    `<b>Job:</b> ${jobName}\n` +
    `<b>Consecutive failures:</b> ${failures}\n` +
    `<b>Last error:</b> ${lastError || 'unknown'}\n` +
    `<b>Status:</b> Circuit OPEN (15min cooldown)`
  );
}

async function alertStaleData(jobName, lastSuccess, intervalMs) {
  const key = `stale:${jobName}`;
  if (!canSend(key)) return;
  const ago = lastSuccess ? Math.round((Date.now() - new Date(lastSuccess).getTime()) / 60000) : '∞';
  await sendTelegram(
    `⚠️ <b>Arena Stale Data</b>\n\n` +
    `<b>Job:</b> ${jobName}\n` +
    `<b>Last success:</b> ${ago} min ago\n` +
    `<b>Expected interval:</b> ${Math.round(intervalMs / 60000)} min`
  );
}

async function alertCPU(usage) {
  const key = 'cpu-high';
  if (!canSend(key)) return;
  await sendTelegram(
    `🔥 <b>Arena VPS CPU High</b>\n\n` +
    `<b>CPU Usage:</b> ${usage.toFixed(1)}%`
  );
}

async function alertRecovery(jobName) {
  const key = `recovery:${jobName}`;
  if (!canSend(key)) return;
  await sendTelegram(
    `✅ <b>Arena Fetcher Recovered</b>\n\n` +
    `<b>Job:</b> ${jobName}\n` +
    `Circuit closed, job running normally again.`
  );
}

function getCPUUsage() {
  try {
    const out = execSync("grep 'cpu ' /proc/stat").toString();
    const parts = out.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3];
    const total = parts.reduce((a, b) => a + b, 0);
    return ((1 - idle / total) * 100);
  } catch {
    return 0;
  }
}

// CLI test
if (require.main === module && process.argv[2] === 'test') {
  require('dotenv').config();
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('⚠️  TELEGRAM_BOT_TOKEN not set in .env');
    console.log('To set up:');
    console.log('1. Message @BotFather on Telegram, create a bot');
    console.log('2. Copy the token to .env TELEGRAM_BOT_TOKEN=...');
    console.log('3. Start a chat with your bot and send /start');
    console.log(`4. Chat ID is already set: ${CHAT_ID}`);
    process.exit(0);
  }
  sendTelegram('🧪 Arena Alert Bot test — if you see this, alerts are working!')
    .then(() => console.log('✅ Test alert sent'))
    .catch(e => console.error('❌ Failed:', e));
}

module.exports = { sendTelegram, alertFetcherDown, alertStaleData, alertCPU, alertRecovery, getCPUUsage };
