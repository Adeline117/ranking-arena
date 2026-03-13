# Arena API Reference

All endpoints return JSON. Base URL: `https://www.arenafi.org/api`

See also: `docs/openapi.yaml` for the full OpenAPI 3.0 specification.

---

## Authentication

Most read endpoints are **public** (no auth required). Write operations require a Supabase auth token:

```
Authorization: Bearer <supabase_access_token>
```

Cron endpoints require:
```
Authorization: Bearer <CRON_SECRET>
```

## Rate Limiting

All public endpoints are rate-limited via Redis-backed counters:
- **Read endpoints**: 500 requests/minute per IP
- **Write endpoints**: 50 requests/minute per IP
- Exceeding the limit returns `429 Too Many Requests` with `Retry-After` header.

---

## Endpoints

### Health

#### `GET /api/health`

Lightweight health check. Returns database and Redis connectivity status.

**Auth**: None
**Cache**: No cache

**Response** (200 or 503):
```json
{
  "status": "healthy",
  "timestamp": "2026-03-13T10:00:00Z",
  "version": "0.1.0",
  "uptime": 86400,
  "responseTimeMs": 42,
  "checks": {
    "api": { "status": "pass", "latency": 1 },
    "database": { "status": "pass", "latency": 38 },
    "redis": { "status": "pass", "latency": 12 }
  }
}
```

**Status codes**: `200` healthy/degraded, `503` unhealthy (database down).

#### `HEAD /api/health`

Lightweight ping. Returns 200 with no body.

---

### Rankings

#### `GET /api/rankings`

Trader leaderboard from `trader_snapshots`. Supports keyset pagination.

**Auth**: None
**Cache**: `s-maxage=60, stale-while-revalidate=300`

**Parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `window` | string | Yes | - | `7d`, `30d`, `90d`, or `composite` |
| `category` | string | No | - | `futures`, `spot`, or `onchain` |
| `platform` | string | No | - | Specific platform (overrides category) |
| `sort_by` | string | No | `arena_score` | `arena_score`, `roi`, `pnl`, `drawdown`, `copiers` |
| `sort_dir` | string | No | `desc` | `asc` or `desc` |
| `limit` | int | No | 100 | Max 500 |
| `offset` | int | No | 0 | Legacy offset pagination |
| `cursor` | string | No | - | Keyset cursor (format: `score:id`) |
| `min_pnl` | number | No | - | Minimum PnL filter |
| `min_trades` | int | No | - | Minimum trades filter |

**Response** (200):
```json
{
  "traders": [
    {
      "platform": "binance_futures",
      "trader_key": "abc123",
      "display_name": "TraderX",
      "avatar_url": "https://...",
      "rank": 1,
      "metrics": {
        "roi": 245.5,
        "pnl": 150000,
        "win_rate": 68.2,
        "max_drawdown": 12.5,
        "trades_count": 342,
        "followers": 1500,
        "arena_score": 87.3,
        "sharpe_ratio": null
      },
      "is_bot": false,
      "trader_type": null,
      "updated_at": "2026-03-13T08:00:00Z"
    }
  ],
  "window": "90D",
  "totalcount": 5200,
  "total_count": 5200,
  "as_of": "2026-03-13T08:00:00Z",
  "is_stale": false,
  "availableSources": ["binance_futures", "bybit", "okx_futures"],
  "next_cursor": "87.3:12345"
}
```

**Error codes**: `400` invalid parameters, `500` internal error.

---

#### `GET /api/traders`

Pre-computed leaderboard from `leaderboard_ranks` table. Faster than `/api/rankings`.

**Auth**: None
**Cache**: `s-maxage=60, stale-while-revalidate=300`

**Parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `timeRange` | string | No | `90D` | `7D`, `30D`, or `90D` |
| `exchange` | string | No | - | Filter by exchange |
| `sortBy` | string | No | `arena_score` | `arena_score`, `roi`, `win_rate`, `max_drawdown` |
| `order` | string | No | `desc` | `asc` or `desc` |
| `cursor` | string | No | - | Rank-based cursor |
| `limit` | int | No | 50 | Max 1000 |
| `page` | int | No | - | Legacy 0-indexed page number |

**Response** (200):
```json
{
  "traders": [
    {
      "id": "abc123",
      "handle": "TraderX",
      "roi": 245.5,
      "pnl": 150000,
      "win_rate": 68.2,
      "max_drawdown": 12.5,
      "trades_count": 342,
      "followers": 1500,
      "source": "binance_futures",
      "source_type": "cex",
      "avatar_url": "https://...",
      "arena_score": 87.3,
      "rank": 1,
      "sharpe_ratio": 1.8,
      "is_bot": false,
      "trader_type": null
    }
  ],
  "timeRange": "90D",
  "totalCount": 5200,
  "rankingMode": "arena_score",
  "lastUpdated": "2026-03-13T08:00:00Z",
  "isStale": false,
  "nextCursor": 50,
  "hasMore": true,
  "availableSources": ["binance_futures", "bybit"]
}
```

---

### Trader Detail

#### `GET /api/v2/trader/{platform}/{market_type}/{trader_key}`

Full trader detail. Database-only, no external API calls. Target <200ms.

**Auth**: None
**Cache**: `s-maxage=60, stale-while-revalidate=300`

**Path Parameters**:

| Param | Type | Description |
|-------|------|-------------|
| `platform` | string | e.g., `binance_futures`, `hyperliquid` |
| `market_type` | string | `futures`, `spot`, or `perp` |
| `trader_key` | string | Trader identifier on the platform |

**Response** (200):
```json
{
  "profile": {
    "platform": "binance_futures",
    "market_type": "futures",
    "trader_key": "abc123",
    "display_name": "TraderX",
    "avatar_url": "https://...",
    "bio": null,
    "tags": ["futures"],
    "followers": 1500,
    "copiers": 300,
    "aum": 2500000
  },
  "snapshots": {
    "7d": { "roi": 12.5, "pnl": 5000, "arena_score": 65.2, "..." : "..." },
    "30d": { "roi": 85.0, "pnl": 45000, "arena_score": 78.1, "..." : "..." },
    "90d": { "roi": 245.5, "pnl": 150000, "arena_score": 87.3, "..." : "..." }
  },
  "timeseries": [],
  "refresh_status": {
    "last_refreshed_at": "2026-03-13T08:00:00Z",
    "is_refreshing": false,
    "next_refresh_at": null
  }
}
```

**Error codes**: `404` trader not found.

---

### Search

#### `GET /api/search`

Unified search across traders, posts, library, users, and groups.

**Auth**: None
**Cache**: `s-maxage=30, stale-while-revalidate=60`

**Parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query (1-100 chars) |
| `limit` | int | No | 5 | Max results per category (max 10) |

**Response** (200):
```json
{
  "success": true,
  "data": {
    "query": "hyper",
    "results": {
      "traders": [
        {
          "id": "hyperliquid:0xabc...",
          "type": "trader",
          "title": "@0xabc...",
          "subtitle": "Hyperliquid",
          "href": "/trader/0xabc...?platform=hyperliquid"
        }
      ],
      "posts": [],
      "library": [],
      "users": [],
      "groups": []
    },
    "total": 1
  },
  "meta": { "timestamp": "2026-03-13T10:00:00Z" }
}
```

---

### Follow

#### `GET /api/follow`

Check if the authenticated user follows a trader.

**Auth**: Required
**Rate limit**: Read (500/min)

**Parameters**:

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `traderId` | string | Yes | Trader ID to check |

**Response** (200):
```json
{ "following": true }
```

#### `POST /api/follow`

Follow or unfollow a trader.

**Auth**: Required
**Rate limit**: Write (50/min)

**Body**:
```json
{
  "traderId": "abc123",
  "action": "follow"
}
```

**Response** (200):
```json
{ "success": true, "following": true }
```

**Error codes**: `400` invalid input, `401` unauthorized, `503` feature not available.

---

### Posts

#### `GET /api/posts`

List community posts with pagination and sorting.

**Auth**: None

**Parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Max 100 |
| `offset` | int | 0 | Pagination offset |
| `sort_by` | string | `created_at` | `created_at`, `hot_score`, `like_count` |
| `sort_order` | string | `desc` | `asc` or `desc` |
| `group_id` | uuid | - | Filter by group |
| `author_handle` | string | - | Filter by author |

**Response** (200):
```json
{
  "success": true,
  "data": {
    "posts": [
      {
        "id": "uuid",
        "title": "BTC Analysis",
        "content": "...",
        "author_handle": "trader1",
        "like_count": 42,
        "comment_count": 8,
        "view_count": 500,
        "created_at": "2026-03-13T10:00:00Z"
      }
    ]
  },
  "pagination": { "limit": 20, "offset": 0, "has_more": true }
}
```

#### `POST /api/posts`

Create a new post.

**Auth**: Required

**Body**:
```json
{
  "title": "My Analysis",
  "content": "BTC is looking bullish...",
  "group_id": "uuid (optional)"
}
```

---

### Groups

#### `GET /api/groups`

List trading groups.

**Auth**: None

**Parameters**: `limit` (default 20), `offset` (default 0)

---

### Sidebar Widgets

#### `GET /api/sidebar/trending`
Trending community discussions. **Auth**: None.

#### `GET /api/sidebar/popular-traders`
Popular traders widget. **Auth**: None.

#### `GET /api/sidebar/news`
Flash news feed. **Auth**: None.

---

### Library

#### `GET /api/library`
Educational resources. Supports `category`, `page`, `limit`.

#### `GET /api/library/{id}`
Single library item detail.

---

### Flash News

#### `GET /api/flash-news`
Real-time crypto news feed. Param: `limit` (default 20).

---

## Standard Response Format

**Success**:
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2026-03-13T10:00:00Z",
    "pagination": { "limit": 20, "offset": 0, "has_more": true }
  }
}
```

**Error**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid parameters",
    "timestamp": "2026-03-13T10:00:00Z"
  }
}
```

## Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `VALIDATION_ERROR` | Invalid request parameters |
| 400 | `INVALID_INPUT` | Malformed request body |
| 401 | `UNAUTHORIZED` | Missing or invalid auth token |
| 403 | `FORBIDDEN` | Insufficient permissions |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `RESOURCE_EXISTS` | Duplicate resource |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Server error |
| 502 | `PROVIDER_ERROR` | External API failure |
