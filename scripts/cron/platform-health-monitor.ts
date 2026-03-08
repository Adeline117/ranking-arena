/**
 * Platform Health Monitor
 * 
 * Checks all platforms' health status and sends Telegram alerts if issues detected.
 * 
 * Usage:
 *   npx tsx scripts/cron/platform-health-monitor.ts
 * 
 * Cron (hourly):
 *   0 * * * * cd ~/ranking-arena && npx tsx scripts/cron/platform-health-monitor.ts >> logs/health-monitor.log 2>&1
 */

import { getAllConnectorKeys, getConnector } from '../../connectors';
import type { Platform, MarketType, Window } from '../../connectors/base/types';
import fs from 'fs';
import path from 'path';

interface PlatformHealth {
  platform: string;
  marketType: string;
  status: 'healthy' | 'degraded' | 'failed';
  responseTime: number;
  dataCount: number;
  error: string | null;
  checkedAt: string;
}

interface HealthReport {
  timestamp: string;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    failed: number;
  };
  platforms: PlatformHealth[];
  alerts: string[];
}

const TEST_WINDOW: Window = '7d';
const TEST_LIMIT = 5;
const TIMEOUT_MS = 30000; // 30s timeout per platform
const HEALTH_FILE = path.join(__dirname, '../../logs/platform-health-latest.json');
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '-1002381931352';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function testPlatform(platform: Platform, marketType: MarketType): Promise<PlatformHealth> {
  const startTime = Date.now();
  const result: PlatformHealth = {
    platform,
    marketType,
    status: 'failed',
    responseTime: 0,
    dataCount: 0,
    error: null,
    checkedAt: new Date().toISOString(),
  };

  try {
    const connector = getConnector(platform, marketType);
    
    if (!connector) {
      result.error = 'Connector not found';
      return result;
    }

    // Set timeout for the test
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Test timeout')), TIMEOUT_MS);
    });

    const testPromise = connector.discoverLeaderboard(TEST_WINDOW, TEST_LIMIT);
    const response = await Promise.race([testPromise, timeoutPromise]);

    result.responseTime = Date.now() - startTime;

    if (response.success && response.data && response.data.length > 0) {
      result.status = 'healthy';
      result.dataCount = response.data.length;
    } else if (response.success && response.data && response.data.length === 0) {
      result.status = 'degraded';
      result.error = 'No data returned';
    } else {
      result.status = 'failed';
      result.error = 'error' in response ? String(response.error) : 'Unknown error';
    }
  } catch (error) {
    result.responseTime = Date.now() - startTime;
    result.status = 'failed';
    result.error = (error as Error).message;
  }

  return result;
}

async function checkAllPlatforms(): Promise<HealthReport> {
  console.warn(`[Health Monitor] Starting platform health check at ${new Date().toISOString()}`);

  const connectorKeys = getAllConnectorKeys();
  const platforms: PlatformHealth[] = [];
  const alerts: string[] = [];

  // Test all platforms sequentially (to avoid overwhelming VPS scraper)
  for (const key of connectorKeys) {
    const [platform, marketType] = key.split(':') as [Platform, MarketType];
    console.warn(`  Testing ${platform}:${marketType}...`);
    
    const health = await testPlatform(platform, marketType);
    platforms.push(health);

    // Generate alert if platform is down
    if (health.status === 'failed') {
      alerts.push(`🔴 ${platform}/${marketType} - FAILED: ${health.error}`);
    } else if (health.status === 'degraded') {
      alerts.push(`🟡 ${platform}/${marketType} - DEGRADED: ${health.error}`);
    } else {
      console.warn(`    ✅ ${platform}/${marketType} - OK (${health.dataCount} traders, ${health.responseTime}ms)`);
    }

    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const summary = {
    total: platforms.length,
    healthy: platforms.filter(p => p.status === 'healthy').length,
    degraded: platforms.filter(p => p.status === 'degraded').length,
    failed: platforms.filter(p => p.status === 'failed').length,
  };

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    summary,
    platforms,
    alerts,
  };

  // Save report to file
  const logsDir = path.dirname(HEALTH_FILE);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(report, null, 2));

  console.warn(`\n[Health Monitor] Summary:`);
  console.warn(`  Total: ${summary.total}`);
  console.warn(`  ✅ Healthy: ${summary.healthy} (${((summary.healthy / summary.total) * 100).toFixed(1)}%)`);
  console.warn(`  🟡 Degraded: ${summary.degraded}`);
  console.warn(`  🔴 Failed: ${summary.failed}`);

  return report;
}

async function sendTelegramAlert(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Telegram] Bot token or chat ID not configured, skipping alert');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      console.warn(`[Telegram] Failed to send alert: ${response.status}`);
    } else {
      console.warn('[Telegram] Alert sent successfully');
    }
  } catch (error) {
    console.warn(`[Telegram] Error sending alert: ${(error as Error).message}`);
  }
}

async function main() {
  try {
    const report = await checkAllPlatforms();

    // Send Telegram alert if there are failures
    if (report.alerts.length > 0) {
      const alertMessage = `🚨 *Arena Platform Health Alert*\n\n` +
        `📊 Summary:\n` +
        `• Total: ${report.summary.total}\n` +
        `• ✅ Healthy: ${report.summary.healthy}\n` +
        `• 🟡 Degraded: ${report.summary.degraded}\n` +
        `• 🔴 Failed: ${report.summary.failed}\n\n` +
        `⚠️ Issues:\n${report.alerts.slice(0, 10).join('\n')}\n\n` +
        `_Check ${HEALTH_FILE} for full report_`;

      await sendTelegramAlert(alertMessage);
    } else {
      console.warn('[Health Monitor] All platforms healthy, no alerts sent');
    }

    // Exit with error code if too many failures
    if (report.summary.failed > report.summary.total * 0.3) {
      console.warn('[Health Monitor] ⚠️ More than 30% platforms failed, exiting with error');
      process.exit(1);
    }
  } catch (error) {
    console.error('[Health Monitor] Fatal error:', error);
    process.exit(1);
  }
}

main();
