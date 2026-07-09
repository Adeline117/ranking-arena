/**
 * GET /api/cron/score-backtest — Arena Score 预测力周检(真前瞻回测)
 *
 * 背景(2026-07-08 一次性回测):过去 ROI/PnL 不预测未来收益(均值回归),v4 权重据此
 * 校准到赚钱 0.50/实力 0.50。本 cron 把该验证变成常设监控,防"拍一次信一辈子":
 *   1. snapshot_score_backtest() — 快照当天的 v4 分数 + 权益(HL 深抓队列 ~550 交易员);
 *   2. evaluate_score_backtest(30) — 评估 ≥30 天前的最老未评估快照:当时的分数五分位
 *      → 之后 30 天权益回报中位 + 秩相关,落 score_backtest_runs。
 *
 * 解读:rank_corr / top_minus_bottom 持续 > 0 → 分数有预测力;持续 ≤ 0 → 分数只是
 * "历史战绩描述",提示回炉权重(这本身也是诚实的结论)。n<100 的 run 视为无结论。
 * 每周积累一个数据点,几个月后即可下有统计意义的判断。
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron('score-backtest', async (_request: NextRequest, { supabase }) => {
  const { data: snapshotted, error: snapErr } = await supabase.rpc('snapshot_score_backtest')
  if (snapErr) logger.error('[score-backtest] snapshot failed:', snapErr.message)

  const { data: evaluation, error: evalErr } = await supabase.rpc('evaluate_score_backtest', {
    p_horizon_days: 30,
  })
  if (evalErr) logger.error('[score-backtest] evaluate failed:', evalErr.message)

  const ev = (evaluation ?? {}) as Record<string, unknown>
  if (ev.status === 'evaluated') {
    logger.info(
      `[score-backtest] ${String(ev.snapshot_date)} n=${String(ev.n)} rank_corr=${String(ev.rank_corr)} Q5-Q1=${String(ev.top_minus_bottom)}`
    )
  }

  return {
    count: (snapshotted as number | null) ?? 0,
    snapshotted: snapshotted ?? 0,
    evaluation: ev,
    errors: [snapErr?.message, evalErr?.message].filter(Boolean),
  }
})
