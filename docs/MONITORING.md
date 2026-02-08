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

1. Create a free account at [UptimeRobot](https://uptimerobot.com/)
2. Add a new monitor:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** `Ranking Arena - Production`
   - **URL:** `https://ranking-arena.vercel.app/api/health`
   - **Monitoring Interval:** 5 minutes
3. Configure alert contacts:
   - **Email:** Add your team email
   - **Telegram:** Use UptimeRobot's Telegram integration (Settings → Alert Contacts → Add → Telegram)
   - **Webhook:** Optionally add a Slack/Discord webhook
4. Set keyword alert (optional):
   - **Keyword Type:** Keyword Exists
   - **Keyword Value:** `"healthy"`
   - This ensures the monitor fails if the app returns degraded/unhealthy status

### Recommended Monitors

| Monitor | URL | Interval | Alert |
|---------|-----|----------|-------|
| Health Check | `/api/health` | 5 min | All contacts |
| Homepage | `/` | 5 min | All contacts |
| API Traders | `/api/traders` | 15 min | All contacts |

---

## Sentry Error Tracking

### Existing Configuration

The project has Sentry configured:
- `sentry.client.config.ts` — Browser error tracking
- `sentry.server.config.ts` — Server-side error tracking
- `sentry.edge.config.ts` — Edge runtime error tracking

### Configuring Sentry Alerts → Telegram

1. **In Sentry Dashboard:**
   - Go to **Settings → Integrations → Telegram** (or use the webhook approach below)

2. **Via Sentry Webhooks + Telegram Bot:**
   - Create a Telegram bot via [@BotFather](https://t.me/BotFather)
   - Get your chat ID (send `/start` to your bot, then check `https://api.telegram.org/bot<TOKEN>/getUpdates`)
   - In Sentry: **Settings → Integrations → WebHooks**
   - Add webhook URL: Use a middleware like [sentry-telegram](https://github.com/bodik/sentry-telegram) or a simple Vercel serverless function:

   ```ts
   // app/api/webhooks/sentry-telegram/route.ts
   export async function POST(req: Request) {
     const body = await req.json();
     const message = `🚨 *Sentry Alert*\n\n*${body.event?.title || 'Unknown Error'}*\n${body.url || ''}`;
     
     await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         chat_id: process.env.TELEGRAM_CHAT_ID,
         text: message,
         parse_mode: 'Markdown',
       }),
     });
     
     return Response.json({ ok: true });
   }
   ```

3. **Configure Alert Rules in Sentry:**
   - Go to **Alerts → Create Alert Rule**
   - **When:** A new issue is created / An event frequency exceeds threshold
   - **Then:** Send a notification via webhook (your Telegram webhook URL)
   - Recommended rules:
     - New issues → Immediate notification
     - Issue frequency > 10 in 1 hour → Alert
     - First seen in new release → Alert

### Environment Variables

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
SENTRY_DSN=your-sentry-dsn
```
