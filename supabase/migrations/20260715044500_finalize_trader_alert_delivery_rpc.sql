-- Atomically cross the durable in-app delivery boundary for a reserved event.
-- External push/email are best-effort followers; the notification, audit rows,
-- baseline advance and one-time disable must either all commit or all roll back.

-- The application has emitted metric-specific trader alert types since March,
-- but production's legacy CHECK constraint still allowed only `trader_alert`.
-- That made every metric-specific notification insert fail at runtime.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN (
      'follow',
      'like',
      'comment',
      'system',
      'mention',
      'message',
      'copy_trade',
      'trader_alert',
      'trader_alert_roi',
      'trader_alert_pnl',
      'trader_alert_score',
      'trader_alert_rank',
      'trader_alert_drawdown',
      'post_reply',
      'new_follower',
      'group_update',
      'ranking_change',
      'referral_reward',
      'tip_received',
      'subscription_expiring',
      'subscription_expired',
      'nft_expired'
    )
  );

CREATE OR REPLACE FUNCTION public.finalize_trader_alert_delivery(
  p_delivery_id uuid,
  p_last_value numeric,
  p_observed_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  delivery public.trader_alert_deliveries%ROWTYPE;
  alert public.trader_alerts%ROWTYPE;
  threshold_value numeric;
BEGIN
  SELECT *
    INTO delivery
  FROM public.trader_alert_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trader alert delivery % not found', p_delivery_id;
  END IF;

  IF delivery.status = 'delivered' THEN
    RETURN false;
  END IF;

  SELECT *
    INTO alert
  FROM public.trader_alerts
  WHERE id = delivery.alert_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trader alert % not found', delivery.alert_id;
  END IF;

  threshold_value := CASE delivery.metric
    WHEN 'roi' THEN alert.roi_change_threshold
    WHEN 'pnl' THEN alert.pnl_change_threshold
    WHEN 'score' THEN alert.score_change_threshold
    WHEN 'rank' THEN alert.rank_change_threshold
    WHEN 'drawdown' THEN alert.drawdown_threshold
  END;

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    message,
    link,
    reference_id
  ) VALUES (
    delivery.user_id,
    delivery.notification_type,
    delivery.title,
    delivery.message,
    delivery.link,
    delivery.id
  ) ON CONFLICT DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.notifications
    WHERE reference_id = delivery.id
      AND type = delivery.notification_type
  ) THEN
    RAISE EXCEPTION 'failed to persist notification for delivery %', delivery.id;
  END IF;

  INSERT INTO public.trader_alert_logs (
    alert_id,
    user_id,
    trader_id,
    alert_type,
    old_value,
    new_value,
    change_percent,
    message,
    delivery_id
  ) VALUES (
    alert.id,
    delivery.user_id,
    alert.trader_id,
    CASE delivery.metric
      WHEN 'roi' THEN 'roi_change'
      WHEN 'pnl' THEN 'pnl_change'
      WHEN 'score' THEN 'score_change'
      WHEN 'rank' THEN 'rank_change'
      ELSE 'drawdown'
    END,
    delivery.old_value,
    delivery.new_value,
    delivery.absolute_change,
    delivery.message,
    delivery.id
  ) ON CONFLICT DO NOTHING;

  INSERT INTO public.alert_history (
    alert_id,
    user_id,
    trader_id,
    alert_type,
    triggered_value,
    threshold_value,
    channels_notified,
    message,
    data,
    delivery_id,
    triggered_at
  ) VALUES (
    alert.id,
    delivery.user_id,
    alert.trader_id,
    delivery.metric,
    delivery.new_value,
    COALESCE(threshold_value, delivery.absolute_change),
    ARRAY['in_app']::text[],
    delivery.message,
    jsonb_build_object(
      'source', alert.source,
      'old_value', delivery.old_value,
      'new_value', delivery.new_value,
      'absolute_change', delivery.absolute_change,
      'baseline_version', delivery.baseline_version
    ),
    delivery.id,
    p_observed_at
  ) ON CONFLICT DO NOTHING;

  INSERT INTO public.trader_alert_states (
    alert_id,
    metric,
    baseline_value,
    last_value,
    baseline_version,
    observed_at,
    updated_at
  ) VALUES (
    alert.id,
    delivery.metric,
    delivery.new_value,
    p_last_value,
    delivery.baseline_version + 1,
    p_observed_at,
    now()
  )
  ON CONFLICT (alert_id, metric) DO UPDATE
  SET baseline_value = EXCLUDED.baseline_value,
      last_value = EXCLUDED.last_value,
      baseline_version = EXCLUDED.baseline_version,
      observed_at = EXCLUDED.observed_at,
      updated_at = now()
  WHERE public.trader_alert_states.baseline_version = delivery.baseline_version;

  UPDATE public.trader_alert_deliveries
  SET status = 'delivered',
      attempt_count = attempt_count + 1,
      last_error = NULL,
      delivered_at = now(),
      updated_at = now()
  WHERE id = delivery.id;

  UPDATE public.trader_alerts
  SET last_triggered_at = now(),
      enabled = CASE WHEN COALESCE(one_time, false) THEN false ELSE enabled END,
      updated_at = now()
  WHERE id = alert.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_trader_alert_delivery(uuid, numeric, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_trader_alert_delivery(uuid, numeric, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.finalize_trader_alert_delivery(uuid, numeric, timestamptz) IS
  'Atomically creates one in-app trader alert, audit rows, advances its metric baseline, and disables one-time alerts.';
