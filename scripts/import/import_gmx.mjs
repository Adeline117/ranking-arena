/**
 * GMX v2 排行榜数据导入
 *
 * API: https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql (Subsquid)
 * 数据: On-chain 永续合约交易数据
 *
 * 用法: node scripts/import/import_gmx.mjs [7D|30D|90D|ALL]
 *
 * 注意: Subsquid 提供的是累计数据 (all-time)，不支持按时间窗口筛选
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SOURCE = 'gmx';
const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const TARGET_COUNT = 500;
const VALUE_SCALE = 1e30;

// 数据校验阈值
const VALIDATION = {
  MIN_ROI: -100,       // 最大亏损 100%
  MAX_ROI: 10000,      // 最大收益 10000%
  MIN_PNL: -10000000,  // 最大亏损 1000 万
  MAX_PNL: 100000000,  // 最大盈利 1 亿
  MIN_CAPITAL: 100,    // 最小资本 $100
};

// Arena Score 计算
const ARENA_CONFIG = {
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  MAX_RETURN_SCORE: 85, MAX_DRAWDOWN_SCORE: 8, MAX_STABILITY_SCORE: 7,
};

const clip = (v, min, max) => Math.max(min, Math.min(max, v));
const safeLog1p = x => x <= -1 ? 0 : Math.log(1 + x);
const getPeriodDays = p => p === '7D' ? 7 : p === '30D' ? 30 : 90;

function calculateArenaScore(roi, pnl, maxDrawdown, winRate, period) {
  const params = ARENA_CONFIG.PARAMS[period] || ARENA_CONFIG.PARAMS['30D'];
  const days = getPeriodDays(period);
  const wr = winRate !== null && winRate !== undefined ? (winRate <= 1 ? winRate * 100 : winRate) : null;
  const intensity = (365 / days) * safeLog1p((roi || 0) / 100);
  const r0 = Math.tanh(params.tanhCoeff * intensity);
  const returnScore = r0 > 0 ? clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85) : 0;
  const drawdownScore = maxDrawdown !== null
    ? clip(ARENA_CONFIG.MAX_DRAWDOWN_SCORE * clip(1 - Math.abs(maxDrawdown) / params.mddThreshold, 0, 1), 0, 8)
    : 4;
  const stabilityScore = wr !== null
    ? clip(ARENA_CONFIG.MAX_STABILITY_SCORE * clip((wr - 45) / (params.winRateCap - 45), 0, 1), 0, 7)
    : 3.5;
  return Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100;
}

function getTargetPeriods() {
  const arg = process.argv[2]?.toUpperCase();
  if (arg === 'ALL') return ['7D', '30D', '90D'];
  if (arg && ['7D', '30D', '90D'].includes(arg)) return [arg];
  return ['90D']; // GMX 数据是累计的，默认只导入 90D
}

async function fetchLeaderboard() {
  console.log('\n📡 获取 GMX v2 排行榜数据...');
  console.log('   API: ' + SUBSQUID_URL);

  const query = `{
    accountStats(
      limit: ${TARGET_COUNT * 2},
      orderBy: realizedPnl_DESC
    ) {
      id
      wins
      losses
      realizedPnl
      volume
      netCapital
      maxCapital
      closedCount
    }
  }`;

  const response = await fetch(SUBSQUID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error('API 请求失败: ' + response.status);
  }

  const data = await response.json();

  if (!data.data?.accountStats) {
    throw new Error('API 返回数据格式错误');
  }

  console.log('   ✓ 获取 ' + data.data.accountStats.length + ' 个交易员');
  return data.data.accountStats;
}

function processTraders(rawTraders, period) {
  const traders = rawTraders
    .map((item, idx) => {
      // 解析 BigInt 值 (1e30 scale)
      const pnl = Number(BigInt(item.realizedPnl || '0')) / VALUE_SCALE;
      const volume = Number(BigInt(item.volume || '0')) / VALUE_SCALE;
      const netCapital = Number(BigInt(item.netCapital || '0')) / VALUE_SCALE;
      const maxCapital = Number(BigInt(item.maxCapital || '0')) / VALUE_SCALE;

      // 计算 ROI (基于最大使用资本)
      const roi = maxCapital > 100 ? (pnl / maxCapital) * 100 : 0;

      // 计算胜率
      const totalTrades = (item.wins || 0) + (item.losses || 0);
      const winRate = totalTrades > 0 ? (item.wins / totalTrades) * 100 : null;

      return {
        address: item.id.toLowerCase(),
        roi,
        pnl,
        winRate,
        volume,
        maxCapital,
        closedCount: item.closedCount || totalTrades,
      };
    });

  // 数据校验和过滤
  const validated = [];
  const filterStats = { roi: 0, pnl: 0, capital: 0 };

  for (const t of traders) {
    // ROI 范围校验
    if (t.roi !== null && (t.roi < VALIDATION.MIN_ROI || t.roi > VALIDATION.MAX_ROI)) {
      filterStats.roi++;
      continue;
    }

    // PnL 范围校验
    if (t.pnl !== null && (t.pnl < VALIDATION.MIN_PNL || t.pnl > VALIDATION.MAX_PNL)) {
      filterStats.pnl++;
      continue;
    }

    // 资本校验（过滤小账户）
    if (t.maxCapital < VALIDATION.MIN_CAPITAL) {
      filterStats.capital++;
      continue;
    }

    validated.push(t);
  }

  console.log('   过滤统计: ROI异常=' + filterStats.roi + ', PnL异常=' + filterStats.pnl + ', 小账户=' + filterStats.capital);

  // 按 ROI 排序
  validated.sort((a, b) => (b.roi || -Infinity) - (a.roi || -Infinity));

  // 分配排名
  return validated.slice(0, TARGET_COUNT).map((t, idx) => ({
    ...t,
    rank: idx + 1,
  }));
}

async function saveTraders(traders, period) {
  console.log('\n💾 保存 ' + traders.length + ' 个交易员到数据库...');

  const capturedAt = new Date().toISOString();
  let saved = 0, errors = 0;

  for (const trader of traders) {
    try {
      // Upsert trader source
      await supabase.from('trader_sources').upsert({
        source: SOURCE,
        source_type: 'leaderboard',
        source_trader_id: trader.address,
        handle: trader.address.slice(0, 6) + '...' + trader.address.slice(-4),
        is_active: true,
      }, { onConflict: 'source,source_trader_id' });

      // Insert snapshot
      const arenaScore = calculateArenaScore(trader.roi, trader.pnl, null, trader.winRate, period);

      const { error } = await supabase.from('trader_snapshots').insert({
        source: SOURCE,
        source_trader_id: trader.address,
        season_id: period,
        rank: trader.rank,
        roi: trader.roi,
        pnl: trader.pnl,
        win_rate: trader.winRate,
        max_drawdown: null,
        followers: null,
        arena_score: arenaScore,
        captured_at: capturedAt,
        raw_data: {
          volume: trader.volume,
          maxCapital: trader.maxCapital,
          closedCount: trader.closedCount,
        },
      });

      if (error) {
        errors++;
      } else {
        saved++;
      }
    } catch (e) {
      errors++;
    }

    // 进度指示
    if ((saved + errors) % 100 === 0) {
      console.log('   进度: ' + (saved + errors) + '/' + traders.length);
    }
  }

  console.log('   ✓ 保存: ' + saved + ', 失败: ' + errors);
  return { saved, errors };
}

async function main() {
  const periods = getTargetPeriods();
  const totalStartTime = Date.now();

  console.log('\n' + '='.repeat(60));
  console.log('GMX v2 排行榜数据导入');
  console.log('目标周期: ' + periods.join(', '));
  console.log('每周期导入: ' + TARGET_COUNT + ' 个交易员');
  console.log('注意: GMX 数据是累计的 (all-time)，按周期分类仅用于 Arena 评分');
  console.log('='.repeat(60));

  // 获取原始数据（只需要请求一次 API）
  const rawTraders = await fetchLeaderboard();

  const results = [];

  for (const period of periods) {
    console.log('\n' + '='.repeat(50));
    console.log('📊 处理 ' + period + ' 数据...');
    console.log('='.repeat(50));

    const traders = processTraders(rawTraders, period);

    if (traders.length === 0) {
      console.log('\n⚠ ' + period + ' 无有效数据，跳过');
      continue;
    }

    console.log('\n📋 ' + period + ' TOP 10:');
    traders.slice(0, 10).forEach((t, idx) => {
      const name = t.address.slice(0, 10) + '...';
      const roiStr = t.roi?.toFixed(2) || 'N/A';
      const pnlStr = t.pnl?.toFixed(0) || 'N/A';
      const wrStr = t.winRate?.toFixed(1) || 'N/A';
      console.log('  ' + (idx + 1) + '. ' + name + ': ROI ' + roiStr + '%, PnL $' + pnlStr + ', WR ' + wrStr + '%');
    });

    const result = await saveTraders(traders, period);
    results.push({ period, count: traders.length, ...result });

    console.log('\n✅ ' + period + ' 完成！');
  }

  const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(60));
  console.log('✅ 全部完成！');
  console.log('='.repeat(60));
  console.log('📊 导入结果:');
  for (const r of results) {
    console.log('   ' + r.period + ': ' + r.saved + ' 保存, ' + r.errors + ' 失败');
  }
  console.log('   总耗时: ' + totalTime + 's');
  console.log('='.repeat(60));
}

main().catch(console.error);
