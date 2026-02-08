# Monitoring & Alerting

## Health Check Endpoint

**URL:** `GET /api/health`

Returns application health status including database connectivity and memory usage.

```json
{
  "status": "healthy",
  "timestamp": "2026-02-08T00:00:00.000Z",
  "version": "0.1.0",
  "uptime": 3600,
  "checks": {
    "database": { "status": "pass", "latency": 12 },
    "memory": { "status": "pass", "message": "45MB / 128MB (35%)" }
  }
}
```

HTTP status codes: `200` (healthy/degraded), `503` (unhealthy).

---

## UptimeRobot Setup

### Free Plan Setup

1. Create a free account at [UptimeRobot](https://uptimerobot.com/) (50 monitors, 5-min intervals)
2. Add a new monitor:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** `Arena - Health`
   - **URL:** `https://www.arenafi.org/api/health`
   - **Monitoring Interval:** 5 minutes
3. Add a keyword monitor (recommended):
   - **Monitor Type:** Keyword
   - **URL:** `https://www.arenafi.org/api/health`
   - **Keyword Type:** Keyword Exists
   - **Keyword Value:** `"healthy"`
   - This catches degraded/unhealthy states that still return HTTP 200

### Alert Contacts

#### Telegram Webhook

1. Go to **My Settings** (top-right) > **Alert Contacts** > **Add Alert Contact**
2. Select **Telegram** as the contact type
3. Click the authorization link to connect your Telegram account/group
4. UptimeRobot bot will message you to confirm — approve it
5. Assign this contact to all monitors

#### Alternative: Telegram Bot Webhook

If you prefer a custom bot:

1. Create a bot via [@BotFather](https://t.me/BotFather), get the token
2. Get your chat ID via `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. In UptimeRobot: **Alert Contacts** > **Add** > **Webhook**
4. URL: `https://api.telegram.org/bot<TOKEN>/sendMessage`
5. POST body: `chat_id=<CHAT_ID>&text=*alertType*+*monitorURL*`

### Recommended Monitors

| Monitor | URL | Type | Interval |
|---------|-----|------|----------|
| Health Check | `https://www.arenafi.org/api/health` | Keyword ("healthy") | 5 min |
| Homepage | `https://www.arenafi.org` | HTTP(s) | 5 min |
| Platform Health | `https://www.arenafi.org/api/platforms/health` | HTTP(s) | 15 min |

---

## Sentry Error Tracking

### Configuration Files

All three Sentry config files are in the project root:

- **`sentry.client.config.ts`** — Browser errors, 5% trace sampling, error replays at 10%
- **`sentry.server.config.ts`** — Server errors, 10% trace sampling (prod), sensitive header stripping
- **`sentry.edge.config.ts`** — Edge/middleware errors, 5% trace sampling (prod)

All configs:
- Strip IP addresses and auth headers before sending
- Tag events with `app: ranking-arena` and platform identifier
- Ignore common non-actionable errors (network failures, ResizeObserver, chunk loads)

### Setting Up Sentry Alert Rules

In the Sentry dashboard (**Alerts > Create Alert Rule**):

#### 1. Error Spike Alert

- **When:** Number of events in an issue exceeds **10 in 1 hour**
- **If:** `app:ranking-arena` AND level is `error` or `fatal`
- **Then:** Send notification to Telegram webhook
- **Action interval:** 60 minutes (avoid spam)

#### 2. New Issue Alert

- **When:** A new issue is created
- **If:** `app:ranking-arena` AND level is `error` or `fatal`
- **Then:** Send notification to Telegram webhook
- **Action interval:** 5 minutes

#### 3. First Seen in Release

- **When:** A new issue is first seen in a release
- **Then:** Send notification to Telegram webhook
- Catches regressions introduced by deploys

#### 4. Performance Alert (Transaction Duration)

- **Metric:** Transaction duration (p95)
- **When:** p95 > 4 seconds for 5 minutes
- **Filter:** `transaction:GET /api/health` or `transaction:GET /api/traders`
- **Then:** Send notification to Telegram webhook

### Telegram Integration for Sentry

**Option A: Native Integration (Sentry Business plan)**

1. **Settings > Integrations > Telegram**
2. Follow OAuth flow to connect your Telegram group
3. Assign as action in alert rules

**Option B: Webhook Relay (Free plan)**

1. Deploy a webhook relay endpoint (already available at `/api/webhooks/sentry-telegram`):

```ts
// app/api/webhooks/sentry-telegram/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  const title = body.event?.title || body.data?.event?.title || 'Unknown Error';
  const url = body.url || '';
  const message = `[Sentry] ${title}\n${url}`;

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
    }),
  });

  return Response.json({ ok: true });
}
```

2. In Sentry: **Settings > Integrations > Webhooks**
3. Add URL: `https://www.arenafi.org/api/webhooks/sentry-telegram`
4. In alert rules, select "Send a notification via webhook" as the action

### Environment Variables

```env
# Sentry
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_DSN=your-sentry-dsn

# Telegram alerts (for Sentry webhook relay)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

---

## Status Page

A public status page is available at [`/status`](https://www.arenafi.org/status).

It shows:
- API health status (from `/api/health`)
- Last leaderboard computation time
- Data freshness per platform (from `/api/platforms/health`)

No authentication required.
