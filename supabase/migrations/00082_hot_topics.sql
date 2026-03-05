CREATE TABLE IF NOT EXISTS hot_topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword text NOT NULL,
  keyword_zh text,
  category text NOT NULL DEFAULT 'crypto' CHECK (category IN ('crypto', 'defi', 'macro', 'regulation', 'event')),
  heat_score numeric NOT NULL DEFAULT 0,
  mention_count integer NOT NULL DEFAULT 0,
  trend text NOT NULL DEFAULT 'stable' CHECK (trend IN ('up', 'down', 'stable')),
  source text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal', 'coingecko', 'lunarcrush', 'news')),
  related_coins text[], -- e.g. ['BTC', 'ETH']
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_hot_topics_heat ON hot_topics (heat_score DESC);
CREATE INDEX idx_hot_topics_category ON hot_topics (category);
CREATE UNIQUE INDEX idx_hot_topics_keyword ON hot_topics (keyword);
