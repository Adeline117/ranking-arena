-- =============================================
-- Ranking Snapshots Feature
--
-- This migration creates tables for:
-- 1. ranking_snapshots - Immutable snapshots of leaderboard at a point in time
-- 2. snapshot_traders - Individual trader data within a snapshot
--
-- Purpose:
-- - Allow users to share and discuss historical rankings
-- - Reduce pressure on real-time accuracy by providing fixed reference points
-- - Enable weekly/monthly report generation
-- =============================================

-- Create ranking_snapshots table
CREATE TABLE IF NOT EXISTS ranking_snapshots (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    -- Snapshot metadata
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,

    -- Snapshot parameters
    time_range text NOT NULL CHECK (time_range IN ('7D', '30D', '90D')),
    exchange text, -- NULL means all exchanges
    category text CHECK (category IN ('all', 'futures', 'spot', 'web3')),

    -- Snapshot content summary
    total_traders integer NOT NULL DEFAULT 0,
    top_trader_handle text,
    top_trader_roi numeric,

    -- Data quality info
    data_captured_at timestamptz NOT NULL,
    data_delay_minutes integer DEFAULT 15,

    -- Sharing info
    share_token text UNIQUE, -- Short unique token for sharing URLs
    is_public boolean DEFAULT true,
    view_count integer DEFAULT 0,

    -- Validity
    expires_at timestamptz, -- NULL means never expires (Pro feature)
    is_expired boolean DEFAULT false,

    -- Additional metadata
    title text, -- Optional title for the snapshot
    description text, -- Optional description

    CONSTRAINT valid_time_range CHECK (time_range IN ('7D', '30D', '90D'))
);

-- Create snapshot_traders table for individual trader data within a snapshot
CREATE TABLE IF NOT EXISTS snapshot_traders (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    snapshot_id uuid NOT NULL REFERENCES ranking_snapshots(id) ON DELETE CASCADE,

    -- Trader identification
    rank integer NOT NULL,
    trader_id text NOT NULL,
    handle text,
    source text NOT NULL,
    avatar_url text,

    -- Performance metrics (captured at snapshot time)
    roi numeric,
    pnl numeric,
    win_rate numeric,
    max_drawdown numeric,
    trades_count integer,
    followers integer,

    -- Arena Score
    arena_score numeric,
    return_score numeric,
    drawdown_score numeric,
    stability_score numeric,

    -- Data quality
    data_availability jsonb, -- Stores which metrics were available vs unavailable

    CONSTRAINT unique_snapshot_rank UNIQUE (snapshot_id, rank)
);

-- Create indexes for efficient querying
CREATE INDEX idx_ranking_snapshots_created_at ON ranking_snapshots(created_at DESC);
CREATE INDEX idx_ranking_snapshots_share_token ON ranking_snapshots(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX idx_ranking_snapshots_created_by ON ranking_snapshots(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX idx_ranking_snapshots_time_range ON ranking_snapshots(time_range, exchange);
CREATE INDEX idx_snapshot_traders_snapshot_id ON snapshot_traders(snapshot_id);
CREATE INDEX idx_snapshot_traders_trader_id ON snapshot_traders(trader_id);

-- Function to generate short share token
CREATE OR REPLACE FUNCTION generate_share_token()
RETURNS text AS $$
DECLARE
    chars text := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    result text := '';
    i integer;
BEGIN
    FOR i IN 1..8 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate share token on insert
CREATE OR REPLACE FUNCTION set_share_token()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.share_token IS NULL THEN
        NEW.share_token := generate_share_token();
        -- Ensure uniqueness
        WHILE EXISTS (SELECT 1 FROM ranking_snapshots WHERE share_token = NEW.share_token) LOOP
            NEW.share_token := generate_share_token();
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ranking_snapshots_set_share_token
    BEFORE INSERT ON ranking_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION set_share_token();

-- Function to increment view count
CREATE OR REPLACE FUNCTION increment_snapshot_view_count(snapshot_share_token text)
RETURNS void AS $$
BEGIN
    UPDATE ranking_snapshots
    SET view_count = view_count + 1
    WHERE share_token = snapshot_share_token;
END;
$$ LANGUAGE plpgsql;

-- RLS Policies
ALTER TABLE ranking_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_traders ENABLE ROW LEVEL SECURITY;

-- Public snapshots are viewable by everyone
CREATE POLICY "Public snapshots are viewable by everyone"
    ON ranking_snapshots FOR SELECT
    USING (is_public = true AND (expires_at IS NULL OR expires_at > now()));

-- Users can view their own snapshots
CREATE POLICY "Users can view own snapshots"
    ON ranking_snapshots FOR SELECT
    USING (created_by = auth.uid());

-- Users can create snapshots
CREATE POLICY "Authenticated users can create snapshots"
    ON ranking_snapshots FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

-- Users can update their own snapshots
CREATE POLICY "Users can update own snapshots"
    ON ranking_snapshots FOR UPDATE
    USING (created_by = auth.uid());

-- Users can delete their own snapshots
CREATE POLICY "Users can delete own snapshots"
    ON ranking_snapshots FOR DELETE
    USING (created_by = auth.uid());

-- Snapshot traders are viewable if parent snapshot is viewable
CREATE POLICY "Snapshot traders viewable with snapshot"
    ON snapshot_traders FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM ranking_snapshots rs
            WHERE rs.id = snapshot_id
            AND (
                rs.is_public = true
                OR rs.created_by = auth.uid()
            )
            AND (rs.expires_at IS NULL OR rs.expires_at > now())
        )
    );

-- Service role can insert snapshot traders
CREATE POLICY "Service can insert snapshot traders"
    ON snapshot_traders FOR INSERT
    WITH CHECK (auth.role() = 'service_role' OR auth.role() = 'authenticated');

-- =============================================
-- Pro User Advanced Alerts
-- =============================================

-- Create advanced_alert_conditions table for Pro users
CREATE TABLE IF NOT EXISTS advanced_alert_conditions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    trader_id text NOT NULL,

    -- Alert configuration
    alert_type text NOT NULL CHECK (alert_type IN ('roi_change', 'drawdown', 'rank_change', 'custom')),
    condition_operator text NOT NULL CHECK (condition_operator IN ('>', '<', '>=', '<=', '=', 'change_by')),
    threshold_value numeric NOT NULL,
    threshold_percent boolean DEFAULT false, -- If true, threshold is a percentage

    -- Time window for condition
    time_window text CHECK (time_window IN ('1H', '4H', '1D', '7D', '30D')),

    -- Alert delivery
    alert_channel text[] DEFAULT ARRAY['push'] CHECK (alert_channel <@ ARRAY['email', 'push', 'sms']),

    -- Alert frequency control
    min_interval_hours integer DEFAULT 24, -- Minimum hours between alerts
    last_triggered_at timestamptz,
    trigger_count integer DEFAULT 0,

    -- Status
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,

    -- Unique constraint per user/trader/alert_type
    CONSTRAINT unique_user_trader_alert UNIQUE (user_id, trader_id, alert_type)
);

-- Create alert history table
CREATE TABLE IF NOT EXISTS alert_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    condition_id uuid REFERENCES advanced_alert_conditions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    trader_id text NOT NULL,

    -- Alert details
    alert_type text NOT NULL,
    triggered_value numeric NOT NULL,
    threshold_value numeric NOT NULL,

    -- Delivery status
    channels_notified text[],
    delivered_at timestamptz DEFAULT now() NOT NULL,
    read_at timestamptz,

    -- Context
    snapshot_data jsonb, -- Trader data at time of alert
    message text
);

-- Indexes for advanced alerts
CREATE INDEX idx_advanced_alerts_user ON advanced_alert_conditions(user_id) WHERE is_active = true;
CREATE INDEX idx_advanced_alerts_trader ON advanced_alert_conditions(trader_id) WHERE is_active = true;
CREATE INDEX idx_alert_history_user ON alert_history(user_id, delivered_at DESC);

-- RLS for advanced alerts
ALTER TABLE advanced_alert_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own alert conditions"
    ON advanced_alert_conditions FOR ALL
    USING (user_id = auth.uid());

CREATE POLICY "Users can view own alert history"
    ON alert_history FOR SELECT
    USING (user_id = auth.uid());

-- =============================================
-- Comments
-- =============================================

COMMENT ON TABLE ranking_snapshots IS 'Immutable snapshots of leaderboard rankings at specific points in time';
COMMENT ON TABLE snapshot_traders IS 'Individual trader data within a ranking snapshot';
COMMENT ON TABLE advanced_alert_conditions IS 'Pro user custom alert conditions for trader monitoring';
COMMENT ON TABLE alert_history IS 'History of triggered alerts for users';

COMMENT ON COLUMN ranking_snapshots.share_token IS 'Short unique token for shareable URLs (e.g., arena.com/s/abc12345)';
COMMENT ON COLUMN ranking_snapshots.expires_at IS 'NULL means never expires (Pro feature). Free users snapshots expire after 7 days';
COMMENT ON COLUMN snapshot_traders.data_availability IS 'JSON object tracking which metrics were available vs unavailable from the exchange';
