-- 添加 arena_score 列到 trader_snapshots 表
ALTER TABLE trader_snapshots 
ADD COLUMN IF NOT EXISTS arena_score NUMERIC(6,2) DEFAULT NULL;

-- 添加索引以支持按 arena_score 排序
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_arena_score 
ON trader_snapshots(source, season_id, arena_score DESC NULLS LAST);

-- 创建 trader_scores 表用于存储详细评分
CREATE TABLE IF NOT EXISTS trader_scores (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  arena_score NUMERIC(6,2) NOT NULL DEFAULT 0,
  return_score NUMERIC(6,2) DEFAULT 0,
  drawdown_score NUMERIC(6,2) DEFAULT 0,
  stability_score NUMERIC(6,2) DEFAULT 0,
  meets_threshold BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_trader_scores_lookup 
ON trader_scores(source, source_trader_id, season_id);

CREATE INDEX IF NOT EXISTS idx_trader_scores_ranking 
ON trader_scores(source, season_id, arena_score DESC);
