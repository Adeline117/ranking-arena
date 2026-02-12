-- chain_analytics: 多链TVL和协议数据 (来自DefiLlama)
CREATE TABLE IF NOT EXISTS chain_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_name TEXT NOT NULL,
  chain_slug TEXT NOT NULL,
  tvl DECIMAL(24, 2),
  top_protocols JSONB DEFAULT '[]',
  protocol_count INTEGER DEFAULT 0,
  captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chain_analytics_slug ON chain_analytics(chain_slug);
CREATE INDEX IF NOT EXISTS idx_chain_analytics_captured ON chain_analytics(captured_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_analytics_slug_time ON chain_analytics(chain_slug, captured_at);

-- RLS: 所有人可读
ALTER TABLE chain_analytics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chain analytics are viewable by everyone"
  ON chain_analytics FOR SELECT USING (true);
