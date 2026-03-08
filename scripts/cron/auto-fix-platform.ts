/**
 * Auto-Fix Platform Script
 * 
 * Attempts to automatically fix platform issues based on health report.
 * 
 * Strategies:
 * 1. Restart VPS scraper if queued > 5
 * 2. Switch to fallback methods for failing platforms
 * 3. Log issues that require manual intervention
 * 
 * Usage:
 *   npx tsx scripts/cron/auto-fix-platform.ts
 * 
 * Cron (every 4 hours):
 *   0 */4 * * * cd ~/ranking-arena && npx tsx scripts/cron/auto-fix-platform.ts >> logs/auto-fix.log 2>&1
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HEALTH_FILE = path.join(__dirname, '../../logs/platform-health-latest.json');
const VPS_HOST = '45.76.152.169';
const VPS_PORT = 3456;
const VPS_KEY = process.env.VPS_PROXY_KEY || 'arena-proxy-sg-2026';

interface HealthReport {
  timestamp: string;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    failed: number;
  };
  platforms: Array<{
    platform: string;
    marketType: string;
    status: 'healthy' | 'degraded' | 'failed';
    error: string | null;
  }>;
}

interface FixAction {
  platform: string;
  action: string;
  success: boolean;
  message: string;
}

async function checkVPSScraperHealth(): Promise<{ busy: boolean; queued: number; ok: boolean }> {
  try {
    const response = await fetch(`http://${VPS_HOST}:${VPS_PORT}/health`, {
      headers: { 'X-Proxy-Key': VPS_KEY },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { busy: true, queued: 999, ok: false };
    }

    const data = await response.json() as { ok: boolean; busy: boolean; queued: number };
    return data;
  } catch {
    return { busy: true, queued: 999, ok: false };
  }
}

async function restartVPSScraper(): Promise<FixAction> {
  console.warn('[Auto-Fix] Attempting to restart VPS scraper...');
  
  try {
    // SSH to VPS and restart scraper
    const command = `ssh root@${VPS_HOST} "pkill -f 'node /opt/scraper/server.js' && cd /opt/scraper && nohup node server.js > /tmp/scraper.log 2>&1 &"`;
    
    await execAsync(command);
    
    // Wait 5 seconds for scraper to start
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if scraper is running
    const health = await checkVPSScraperHealth();
    
    if (health.ok && !health.busy) {
      return {
        platform: 'VPS Scraper',
        action: 'restart',
        success: true,
        message: `Scraper restarted successfully (queued: ${health.queued})`,
      };
    } else {
      return {
        platform: 'VPS Scraper',
        action: 'restart',
        success: false,
        message: `Scraper restart attempted but still unhealthy (ok: ${health.ok}, busy: ${health.busy})`,
      };
    }
  } catch (error) {
    return {
      platform: 'VPS Scraper',
      action: 'restart',
      success: false,
      message: `Restart failed: ${(error as Error).message}`,
    };
  }
}

async function attemptPlatformFix(platform: string, marketType: string, error: string | null): Promise<FixAction> {
  console.warn(`[Auto-Fix] Attempting fix for ${platform}/${marketType}...`);
  
  // Strategy 1: If VPS-related error, try restarting scraper
  if (error?.includes('VPS') || error?.includes('timeout') || error?.includes('queue')) {
    const vpsHealth = await checkVPSScraperHealth();
    
    if (vpsHealth.queued > 5 || !vpsHealth.ok) {
      return restartVPSScraper();
    }
  }

  // Strategy 2: Check if platform has known fix
  const knownFixes: Record<string, string> = {
    'bybit': 'Requires browser automation (Playwright)',
    'kucoin': 'Requires browser automation (Playwright)',
    'htx': 'May require browser automation or API update',
    'binance_futures': 'Requires Cloudflare Worker deployment',
    'binance_spot': 'Requires Cloudflare Worker deployment',
  };

  if (knownFixes[platform]) {
    return {
      platform: `${platform}/${marketType}`,
      action: 'manual_fix_required',
      success: false,
      message: knownFixes[platform],
    };
  }

  // Strategy 3: Generic retry (wait and see if it recovers)
  return {
    platform: `${platform}/${marketType}`,
    action: 'monitor',
    success: false,
    message: 'No automatic fix available, monitoring for recovery',
  };
}

async function main() {
  console.warn(`[Auto-Fix] Starting at ${new Date().toISOString()}`);

  // Check if health report exists
  if (!fs.existsSync(HEALTH_FILE)) {
    console.warn('[Auto-Fix] No health report found, run platform-health-monitor.ts first');
    return;
  }

  // Load health report
  const report: HealthReport = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
  
  console.warn(`[Auto-Fix] Health report from: ${report.timestamp}`);
  console.warn(`[Auto-Fix] Failed platforms: ${report.summary.failed}/${report.summary.total}`);

  // Check VPS scraper health first
  const vpsHealth = await checkVPSScraperHealth();
  console.warn(`[Auto-Fix] VPS Scraper status: ok=${vpsHealth.ok}, busy=${vpsHealth.busy}, queued=${vpsHealth.queued}`);

  const fixes: FixAction[] = [];

  // Fix 1: Restart VPS scraper if too many queued or unhealthy
  if (vpsHealth.queued > 5 || !vpsHealth.ok) {
    const fix = await restartVPSScraper();
    fixes.push(fix);
    
    if (fix.success) {
      console.warn('[Auto-Fix] ✅ VPS scraper restarted, waiting 30s before retesting platforms...');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }

  // Fix 2: Attempt to fix failed platforms
  const failedPlatforms = report.platforms.filter(p => p.status === 'failed');
  
  for (const platform of failedPlatforms.slice(0, 5)) { // Limit to 5 fixes per run
    const fix = await attemptPlatformFix(platform.platform, platform.marketType, platform.error);
    fixes.push(fix);
    
    // Small delay between fixes
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Summary
  console.warn(`\n[Auto-Fix] Summary:`);
  console.warn(`  Total fixes attempted: ${fixes.length}`);
  console.warn(`  Successful: ${fixes.filter(f => f.success).length}`);
  console.warn(`  Failed: ${fixes.filter(f => !f.success).length}`);
  
  fixes.forEach(fix => {
    const status = fix.success ? '✅' : '❌';
    console.warn(`  ${status} ${fix.platform} - ${fix.action}: ${fix.message}`);
  });

  // Save fix report
  const fixReportPath = path.join(__dirname, '../../logs/auto-fix-latest.json');
  fs.writeFileSync(fixReportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    fixes,
  }, null, 2));

  console.warn(`[Auto-Fix] Report saved to ${fixReportPath}`);
}

main();
