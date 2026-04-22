-- Migration: 20260422121538_optimize_notifications_rpc.sql
-- Optimize notifications: single RPC replaces 3 round-trips (notifications + actors + unread count)
-- Addresses 53s response time on /api/notifications

CREATE OR REPLACE FUNCTION get_user_notifications(
  p_user_id UUID,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_unread_only BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  type TEXT,
  title TEXT,
  message TEXT,
  link TEXT,
  read BOOLEAN,
  actor_id UUID,
  reference_id TEXT,
  created_at TIMESTAMPTZ,
  actor_handle TEXT,
  actor_avatar_url TEXT,
  unread_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH notifs AS (
    SELECT n.id, n.user_id, n.type::TEXT, n.title, n.message, n.link,
           n.read, n.actor_id, n.reference_id, n.created_at
    FROM notifications n
    WHERE n.user_id = p_user_id
      AND (NOT p_unread_only OR n.read = FALSE)
    ORDER BY n.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ),
  unread AS (
    SELECT COUNT(*) AS cnt
    FROM notifications
    WHERE user_id = p_user_id AND read = FALSE
  )
  SELECT
    notifs.id,
    notifs.user_id,
    notifs.type,
    notifs.title,
    notifs.message,
    notifs.link,
    notifs.read,
    notifs.actor_id,
    notifs.reference_id,
    notifs.created_at,
    up.handle AS actor_handle,
    up.avatar_url AS actor_avatar_url,
    unread.cnt AS unread_count
  FROM notifs
  LEFT JOIN user_profiles up ON up.id = notifs.actor_id
  CROSS JOIN unread
  ORDER BY notifs.created_at DESC;
$$;

COMMENT ON FUNCTION get_user_notifications IS 'Single-call notifications fetch: joins actor profiles + unread count in one round-trip';
