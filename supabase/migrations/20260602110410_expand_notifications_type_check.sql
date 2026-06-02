-- Expand notifications.type CHECK to match all TypeScript NotificationType values.
-- The original CHECK only allowed 6 types but the app uses 14+.
-- Raw inserts with 'tip_received' or 'subscription' were silently failing.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'follow', 'like', 'comment', 'system', 'mention', 'message',
    'copy_trade', 'trader_alert', 'post_reply', 'new_follower',
    'group_update', 'ranking_change', 'referral_reward', 'tip_received',
    'subscription_expiring', 'subscription_expired', 'nft_expired'
  ]));
