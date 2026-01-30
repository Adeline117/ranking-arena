-- 为 trader_snapshots 添加 upsert 所需的唯一约束
-- 每个 (source, source_trader_id, season_id) 只保留一条记录
-- 旧约束包含 captured_at，允许重复；新约束不含 captured_at

-- 删除旧的包含 captured_at 的唯一约束
ALTER TABLE trader_snapshots
  DROP CONSTRAINT IF EXISTS trader_snapshots_unique_per_season;

-- 添加新的唯一约束（不含 captured_at），用于 upsert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_trader_snapshots_source_trader_season'
  ) THEN
    ALTER TABLE trader_snapshots
      ADD CONSTRAINT uq_trader_snapshots_source_trader_season
      UNIQUE (source, source_trader_id, season_id);
  END IF;
END $$;
