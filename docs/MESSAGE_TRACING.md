# Message System Tracing Guide

## Overview

The message system uses structured logging and tracing to monitor message delivery lifecycle from send to read.

## Message Lifecycle Events

| Event | Description | Logged At |
|-------|-------------|-----------|
| `send` | Message sent by user | `POST /api/messages` |
| `delivered` | Message saved to database | After DB insert |
| `read` | Message marked as read | `GET /api/messages` or realtime |
| `failed` | Message delivery failed | On any error |
| `conversation_created` | New conversation started | `POST /api/messages/start` |
| `notification_sent` | Push notification dispatched | After notification creation |

## Using the Trace Function

```typescript
import { traceMessage } from '@/lib/utils/logger'

// When sending a message
traceMessage({
  event: 'send',
  messageId: message.id,
  conversationId: conversation.id,
  senderId: currentUserId,
  receiverId: otherUserId,
})

// When message delivery fails
traceMessage({
  event: 'failed',
  conversationId: conversation.id,
  senderId: currentUserId,
  error: 'Permission denied: recipient has DMs disabled',
})

// When message is read
traceMessage({
  event: 'read',
  messageId: message.id,
  conversationId: conversation.id,
  senderId: message.sender_id,
  receiverId: currentUserId,
})
```

## Log Format

Message traces are logged with the following structure:

```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "senderId": "uuid",
  "receiverId": "uuid",
  "event": "send|delivered|read|failed",
  "timestamp": "2026-01-21T12:00:00.000Z",
  "metadata": {}
}
```

## Sentry Integration

All message events are:
1. Logged to console (dev) or structured logs (prod)
2. Added as Sentry breadcrumbs for error correlation
3. Errors captured as Sentry exceptions

## Monitoring Queries

### Database Queries

```sql
-- Recent message activity
SELECT dm.id, dm.sender_id, dm.receiver_id, dm.created_at, dm.read
FROM direct_messages dm
ORDER BY dm.created_at DESC
LIMIT 100;

-- Undelivered messages (potential issues)
SELECT dm.*, c.user1_id, c.user2_id
FROM direct_messages dm
JOIN conversations c ON dm.conversation_id = c.id
WHERE dm.read = false
AND dm.created_at < NOW() - INTERVAL '1 hour';

-- Message volume by hour
SELECT
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as message_count
FROM direct_messages
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour;
```

### Log Analysis

```bash
# Find failed messages
grep "Message failed" /var/log/app/*.log

# Trace specific conversation
grep "conversationId.*abc123" /var/log/app/*.log

# Count events by type
grep -oP '"event":"\K[^"]+' /var/log/app/*.log | sort | uniq -c
```

## Real-time Monitoring

The system uses Supabase Realtime for:
- New message notifications
- Read receipt updates
- Online presence tracking

Real-time events are also logged via `realtimeLogger`:

```typescript
realtimeLogger.info('Message received', { conversationId, messageId })
```

## Error Scenarios

### Permission Denied
- User has DMs disabled (`dm_permission = 'none'`)
- Non-mutual follower exceeds 3 message limit
- Blocked user attempting to message

### Delivery Failures
- Database write error
- Notification service unavailable
- Rate limiting exceeded

### Read Receipt Failures
- Connection dropped during mark-as-read
- User offline for extended period

## Performance Considerations

1. **Batch read receipts**: Mark multiple messages as read in one operation
2. **Debounce realtime updates**: Prevent excessive re-renders
3. **Index optimization**: Ensure indexes on `conversation_id`, `sender_id`, `receiver_id`

## Related Files

- `/lib/utils/logger.ts` - Logger utilities and `traceMessage` function
- `/app/api/messages/route.ts` - Message API endpoints
- `/app/api/messages/start/route.ts` - Conversation start endpoint
- `/lib/hooks/useRealtime.ts` - Real-time subscription hooks
- `/scripts/sql/setup_user_messaging.sql` - Database schema
