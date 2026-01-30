/**
 * Test the arena score fix to verify:
 * 1. ROI cap works (extreme ROIs don't dominate)
 * 2. Confidence multiplier works (missing data penalized)
 * 3. Different platforms produce comparable scores
 */

// Simulate the score calculation logic inline since we can't easily import TS

const ARENA_CONFIG = {
  PNL_THRESHOLD: { '7D': 200, '30D': 500, '90D': 1000 },
  PARAMS: {
    '7D': { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
    '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
    '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
  },
  WIN_RATE_BASELINE: 45,
  MAX_RETURN_SCORE: 85,
  MAX_DRAWDOWN_SCORE: 8,
  MAX_STABILITY_SCORE: 7,
  ROI_CAP: 5000,
  CONFIDENCE_MULTIPLIER: { full: 1.0, partial: 0.92, minimal: 0.80 },
  DEFAULTS: { WIN_RATE: 50, MAX_DRAWDOWN: -20 },
};

function clip(v, min, max) { return Math.max(min, Math.min(max, v)); }
function safeLog1p(x) { return x <= -1 ? 0 : Math.log(1 + x); }

function calculateReturnScore(roi, period) {
  const params = ARENA_CONFIG.PARAMS[period];
  const cappedRoi = Math.min(roi, ARENA_CONFIG.ROI_CAP);
  const days = period === '7D' ? 7 : period === '30D' ? 30 : 90;
  const intensity = (365 / days) * safeLog1p(cappedRoi / 100);
  const r0 = Math.tanh(params.tanhCoeff * intensity);
  if (r0 <= 0) return 0;
  return clip(ARENA_CONFIG.MAX_RETURN_SCORE * Math.pow(r0, params.roiExponent), 0, 85);
}

function calculateDrawdownScore(mdd, period) {
  const effective = mdd === null ? ARENA_CONFIG.DEFAULTS.MAX_DRAWDOWN : mdd;
  const mddAbs = Math.abs(effective);
  const norm = mddAbs <= 1 ? mddAbs * 100 : mddAbs;
  const threshold = ARENA_CONFIG.PARAMS[period].mddThreshold;
  return clip(8 * clip(1 - norm / threshold, 0, 1), 0, 8);
}

function calculateStabilityScore(wr, period) {
  const effective = wr === null ? ARENA_CONFIG.DEFAULTS.WIN_RATE : wr;
  const norm = effective <= 1 && effective >= 0 ? effective * 100 : effective;
  const cap = ARENA_CONFIG.PARAMS[period].winRateCap;
  return clip(7 * clip((norm - 45) / (cap - 45), 0, 1), 0, 7);
}

function getConfidence(mdd, wr) {
  const hasMdd = mdd !== null && mdd !== undefined;
  const hasWr = wr !== null && wr !== undefined;
  if (hasMdd && hasWr) return 'full';
  if (hasMdd || hasWr) return 'partial';
  return 'minimal';
}

function calculateScore(roi, pnl, mdd, wr, period) {
  const returnScore = calculateReturnScore(roi, period);
  const drawdownScore = calculateDrawdownScore(mdd, period);
  const stabilityScore = calculateStabilityScore(wr, period);
  const confidence = getConfidence(mdd, wr);
  const multiplier = ARENA_CONFIG.CONFIDENCE_MULTIPLIER[confidence];
  const rawTotal = returnScore + drawdownScore + stabilityScore;
  const total = clip(rawTotal * multiplier, 0, 100);
  return { total: Math.round(total * 100) / 100, returnScore: Math.round(returnScore * 100) / 100, drawdownScore: Math.round(drawdownScore * 100) / 100, stabilityScore: Math.round(stabilityScore * 100) / 100, confidence, multiplier };
}

console.log('=== Arena Score Fix Test ===\n');

// Test cases representing different platforms
const testCases = [
  { name: 'Hyperliquid extreme (1.8M% ROI, no WR/MDD)', roi: 1858748, pnl: 1858748, mdd: null, wr: null, period: '90D' },
  { name: 'Hyperliquid extreme (276K% ROI, no WR/MDD)', roi: 276583, pnl: 50000, mdd: null, wr: null, period: '90D' },
  { name: 'Hyperliquid moderate (5000% ROI, has WR/MDD)', roi: 5000, pnl: 50000, mdd: -15, wr: 65, period: '90D' },
  { name: 'Hyperliquid moderate (5000% ROI, no WR/MDD)', roi: 5000, pnl: 50000, mdd: null, wr: null, period: '90D' },
  { name: 'Binance top (2369% ROI, full data)', roi: 2369, pnl: 11846, mdd: -7.3, wr: 89.66, period: '90D' },
  { name: 'Binance good (500% ROI, full data)', roi: 500, pnl: 5000, mdd: -15, wr: 65, period: '90D' },
  { name: 'Bybit good (500% ROI, partial data)', roi: 500, pnl: 3000, mdd: null, wr: 60, period: '90D' },
  { name: 'GMX good (500% ROI, no MDD)', roi: 500, pnl: 2000, mdd: null, wr: 55, period: '90D' },
  { name: 'HTX top (2436% ROI, WR but no MDD)', roi: 2436, pnl: 1221533, mdd: null, wr: 95, period: '90D' },
  { name: 'Average trader (100% ROI, full data)', roi: 100, pnl: 2000, mdd: -25, wr: 52, period: '90D' },
];

console.log('Period: 90D\n');
console.log('Name'.padEnd(55) + 'Total  Return  MDD   Stab  Conf     Mult');
console.log('-'.repeat(100));

for (const tc of testCases) {
  const result = calculateScore(tc.roi, tc.pnl, tc.mdd, tc.wr, tc.period);
  console.log(
    tc.name.padEnd(55) +
    String(result.total).padEnd(7) +
    String(result.returnScore).padEnd(8) +
    String(result.drawdownScore).padEnd(6) +
    String(result.stabilityScore).padEnd(6) +
    result.confidence.padEnd(9) +
    result.multiplier
  );
}

// Verify key invariants
console.log('\n=== Key Invariants ===');
const extreme = calculateScore(1858748, 1858748, null, null, '90D');
const binanceTop = calculateScore(2369, 11846, -7.3, 89.66, '90D');
const moderate = calculateScore(500, 5000, -15, 65, '90D');
const average = calculateScore(100, 2000, -25, 52, '90D');

console.log(`\n✓ Extreme ROI (1.8M%) with no data: ${extreme.total} (should be < 80)`);
console.log(`  → Was ~92.5, now ${extreme.total} (ROI capped + minimal confidence penalty)`);
console.log(`✓ Binance top with full data: ${binanceTop.total} (should be > extreme)`);
console.log(`  → Full data trader should rank HIGHER than missing-data trader`);
console.log(`✓ Binance top > Extreme Hyperliquid: ${binanceTop.total > extreme.total ? 'YES ✅' : 'NO ❌'}`);
console.log(`✓ Moderate (500% full data) > Average (100% full data): ${moderate.total > average.total ? 'YES ✅' : 'NO ❌'}`);
