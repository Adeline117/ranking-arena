-- Migration: 20260422005828_redeem_invite_code_atomic.sql
-- Created: 2026-04-22
-- Description: Atomic invite code redemption RPC
--
-- Fixes C-2: race condition in current_uses increment + non-atomic 3-step write.
-- Uses SELECT ... FOR UPDATE to lock the invite_codes row, preventing
-- concurrent redemptions from reading the same current_uses value.

CREATE OR REPLACE FUNCTION redeem_invite_code(
  p_code TEXT,
  p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite RECORD;
  v_trial_expires_at TIMESTAMPTZ;
  v_existing_redemption UUID;
  v_any_redemption UUID;
BEGIN
  -- 1. Lock and validate the invite code (FOR UPDATE prevents concurrent reads)
  SELECT id, code, creator_id, max_uses, current_uses, trial_days, trial_tier, expires_at, is_active
  INTO v_invite
  FROM invite_codes
  WHERE code = UPPER(p_code)
  FOR UPDATE;

  IF v_invite IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '邀请码不存在');
  END IF;

  IF NOT v_invite.is_active THEN
    RETURN jsonb_build_object('success', false, 'error', '邀请码已失效');
  END IF;

  IF v_invite.expires_at IS NOT NULL AND v_invite.expires_at < NOW() THEN
    RETURN jsonb_build_object('success', false, 'error', '邀请码已过期');
  END IF;

  IF v_invite.current_uses >= v_invite.max_uses THEN
    RETURN jsonb_build_object('success', false, 'error', '邀请码使用次数已达上限');
  END IF;

  -- 2. Check if user already redeemed THIS code
  SELECT id INTO v_existing_redemption
  FROM invite_redemptions
  WHERE code_id = v_invite.id AND user_id = p_user_id
  LIMIT 1;

  IF v_existing_redemption IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '你已经使用过此邀请码');
  END IF;

  -- 3. Check if user already redeemed ANY code
  SELECT id INTO v_any_redemption
  FROM invite_redemptions
  WHERE user_id = p_user_id
  LIMIT 1;

  IF v_any_redemption IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '你已经使用过其他邀请码');
  END IF;

  -- 4. Calculate trial expiry
  v_trial_expires_at := NOW() + (v_invite.trial_days || ' days')::INTERVAL;

  -- 5. All 3 writes in single transaction (guaranteed by plpgsql)

  -- 5a. Record redemption
  INSERT INTO invite_redemptions (code_id, user_id, trial_expires_at)
  VALUES (v_invite.id, p_user_id, v_trial_expires_at);

  -- 5b. Atomic counter increment (no read-modify-write race)
  UPDATE invite_codes
  SET current_uses = current_uses + 1
  WHERE id = v_invite.id;

  -- 5c. Create/update subscription
  INSERT INTO user_subscriptions (user_id, tier, status, trial_ends_at, source, invite_code_id)
  VALUES (p_user_id, v_invite.trial_tier, 'trial', v_trial_expires_at, 'invite_code', v_invite.id)
  ON CONFLICT (user_id) DO UPDATE SET
    tier = EXCLUDED.tier,
    status = EXCLUDED.status,
    trial_ends_at = EXCLUDED.trial_ends_at,
    source = EXCLUDED.source,
    invite_code_id = EXCLUDED.invite_code_id;

  RETURN jsonb_build_object(
    'success', true,
    'trial_expires_at', v_trial_expires_at
  );
END;
$$;
