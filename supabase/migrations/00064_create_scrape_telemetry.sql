-- Create scrape_telemetry table for cron monitoring
CREATE TABLE IF NOT EXISTS public.scrape_telemetry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running', -- running, success, error
  records_fetched int DEFAULT 0,
  records_upserted int DEFAULT 0,
  error_message text,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for querying latest runs per source
CREATE INDEX IF NOT EXISTS idx_scrape_telemetry_source_started 
  ON public.scrape_telemetry(source, started_at DESC);

-- Enable RLS
ALTER TABLE public.scrape_telemetry ENABLE ROW LEVEL SECURITY;

-- Only service role can write, public can read
CREATE POLICY "Public read scrape_telemetry" ON public.scrape_telemetry
  FOR SELECT USING (true);

COMMENT ON TABLE public.scrape_telemetry IS 'Tracks data scraping cron job execution for monitoring';
