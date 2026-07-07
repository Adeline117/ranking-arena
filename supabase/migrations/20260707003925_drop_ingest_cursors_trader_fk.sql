-- Migration: 20260707003925_drop_ingest_cursors_trader_fk.sql
-- Created: 2026-07-07T07:39:25Z
-- Description: 去掉 arena.ingest_cursors 的 trader_id→traders 外键 —— 它挡死了
--   series_backfill 的负数哨兵游标写入(根因,见下)。
--
-- 根因(2026-07-07 实测):arena.ingest_cursors 双用途——per-trader 游标用正数
--   trader_id,series_backfill 用负数哨兵 trader_id = -sourceId(表 CHECK 已列入
--   'series_backfill' kind、代码注释明确此设计)。但 trader_id 上有
--   FK → arena.traders(id) ON DELETE CASCADE,负哨兵在 traders 里无对应行 →
--   每次 writeCursor('series_backfill') 抛 23503 → 游标永不落库 → tier-b-series
--   每轮从 offset 0 重抓 band 头部,长尾数千交易员从未深抓(全站 CEX sharpe/mdd/
--   pnl 长尾缺口的单一根因)。实测:INSERT trader_id=-15 → 23503。
--
-- 处置:FK 与「存 per-source 负哨兵」的既有设计天然冲突,是 FK 错。去掉后既有代码
--   即可写入。代价:per-trader 游标失去删除级联清理 → 交易员被删后留孤儿游标行
--   (永不读、serial id 不复用,无害;需要时 maintenance sweep 清)。
-- 详见 docs/SERIES_BACKFILL_CURSOR_FIX_PLAN.md。

-- Up
ALTER TABLE arena.ingest_cursors
  DROP CONSTRAINT IF EXISTS ingest_cursors_trader_id_fkey;
