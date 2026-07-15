-- Persistent state and idempotent delivery ledger for 30-minute trader alerts.
--
-- State is stored per alert + metric so small movements accumulate from the
-- last successfully delivered baseline. Delivery rows reserve one event for a
-- baseline version; retries reuse that row instead of producing a new alert.

CREATE TABLE public.trader_alert_states (
  alert_id uuid NOT NULL REFERENCES public.trader_alerts(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('roi', 'pnl', 'score', 'rank', 'drawdown')),
  baseline_value numeric NOT NULL,
  last_value numeric NOT NULL,
  baseline_version bigint NOT NULL DEFAULT 0 CHECK (baseline_version >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, metric)
);

CREATE TABLE public.trader_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.trader_alerts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('roi', 'pnl', 'score', 'rank', 'drawdown')),
  baseline_version bigint NOT NULL CHECK (baseline_version >= 0),
  old_value numeric NOT NULL,
  new_value numeric NOT NULL,
  absolute_change numeric NOT NULL CHECK (absolute_change >= 0),
  notification_type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_id, metric, baseline_version)
);

CREATE INDEX trader_alert_deliveries_pending_idx
  ON public.trader_alert_deliveries (created_at)
  WHERE status = 'pending';

-- An in-app notification is the durable delivery boundary. A retry after a
-- process crash reuses delivery.id as reference_id, so this index prevents a
-- duplicate even when the first insert succeeded but its response was lost.
CREATE UNIQUE INDEX notifications_trader_alert_delivery_uidx
  ON public.notifications (reference_id)
  WHERE reference_id IS NOT NULL
    AND type IN (
      'trader_alert_roi',
      'trader_alert_pnl',
      'trader_alert_score',
      'trader_alert_rank',
      'trader_alert_drawdown'
    );

ALTER TABLE public.trader_alert_logs
  ADD COLUMN delivery_id uuid REFERENCES public.trader_alert_deliveries(id) ON DELETE SET NULL;

ALTER TABLE public.alert_history
  ADD COLUMN delivery_id uuid REFERENCES public.trader_alert_deliveries(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX trader_alert_logs_delivery_uidx
  ON public.trader_alert_logs (delivery_id)
  WHERE delivery_id IS NOT NULL;

CREATE UNIQUE INDEX alert_history_delivery_uidx
  ON public.alert_history (delivery_id)
  WHERE delivery_id IS NOT NULL;

ALTER TABLE public.trader_alert_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trader_alert_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service manages trader alert states"
  ON public.trader_alert_states
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service manages trader alert deliveries"
  ON public.trader_alert_deliveries
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.trader_alert_states FROM anon, authenticated;
REVOKE ALL ON public.trader_alert_deliveries FROM anon, authenticated;
GRANT ALL ON public.trader_alert_states TO service_role;
GRANT ALL ON public.trader_alert_deliveries TO service_role;

COMMENT ON TABLE public.trader_alert_states IS
  'Per-metric alert baselines and latest observations for cumulative threshold checks.';
COMMENT ON TABLE public.trader_alert_deliveries IS
  'Idempotent trader-alert event reservations and durable in-app delivery status.';
COMMENT ON COLUMN public.trader_alert_deliveries.baseline_version IS
  'The state version that produced this event; unique per alert and metric.';
