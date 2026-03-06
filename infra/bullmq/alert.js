// Telegram 告警模块
const https = require('https');
const { execSync } = require('child_process');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '5646617467';

// 去重: 同一告警 30 分钟内只发一次
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
    console.log(`[告警-无TOKEN] ${text}`);
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
          console.error(`Telegram API 错误: ${res.statusCode} ${data}`);
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
    `\u{1F534} <b>Fetcher 不可用</b>\n\n` +
    `<b>任务:</b> ${jobName}\n` +
    `<b>连续失败:</b> ${failures} 次\n` +
    `<b>最后错误:</b> ${lastError || '未知'}\n` +
    `<b>状态:</b> 熔断开启 (15分钟冷却)`
  );
}

async function alertStaleData(jobName, lastSuccess, intervalMs) {
  const key = `stale:${jobName}`;
  if (!canSend(key)) return;
  const ago = lastSuccess ? Math.round((Date.now() - new Date(lastSuccess).getTime()) / 60000) : '\u{221E}';
  await sendTelegram(
    `\u{1F7E1} <b>数据过期</b>\n\n` +
    `<b>任务:</b> ${jobName}\n` +
    `<b>上次成功:</b> ${ago} 分钟前\n` +
    `<b>预期间隔:</b> ${Math.round(intervalMs / 60000)} 分钟`
  );
}

async function alertCPU(usage) {
  const key = 'cpu-high';
  if (!canSend(key)) return;
  await sendTelegram(
    `\u{1F525} <b>VPS CPU 过高</b>\n\n` +
    `<b>CPU 使用率:</b> ${usage.toFixed(1)}%`
  );
}

async function alertRecovery(jobName) {
  const key = `recovery:${jobName}`;
  if (!canSend(key)) return;
  await sendTelegram(
    `\u{2705} <b>Fetcher 已恢复</b>\n\n` +
    `<b>任务:</b> ${jobName}\n` +
    `熔断已关闭，任务正常运行。`
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

// CLI 测试
if (require.main === module && process.argv[2] === 'test') {
  require('dotenv').config();
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN 未设置');
    process.exit(0);
  }
  sendTelegram('\u{1F9EA} Arena 告警机器人测试 — 如果看到这条消息，说明告警正常工作！')
    .then(() => console.log('\u{2705} 测试告警已发送'))
    .catch(e => console.error('\u{274C} 失败:', e));
}

module.exports = { sendTelegram, alertFetcherDown, alertStaleData, alertCPU, alertRecovery, getCPUUsage };
