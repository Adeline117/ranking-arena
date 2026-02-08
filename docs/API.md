# Arena API Reference

Quick reference for the main API routes. All endpoints return JSON.

## Endpoints

### `GET /api/traders`
Leaderboard data. Supports query params:
- `timeRange` — `7D`, `30D`, `90D`, `180D`, `365D` (default: `90D`)
- `limit` — number of results (default: 20)
- `offset` — pagination offset

Returns: `{ traders: [...], lastUpdated: string }`

### `GET /api/traders/:handle`
Single trader profile + performance data.

Returns: `{ profile: {...}, performance: {...}, stats: {...} }`

### `GET /api/sidebar/trending`
Trending community discussions for the sidebar widget.

Returns: `{ posts: [...] }`

### `GET /api/sidebar/popular-traders`
Popular traders widget data.

### `GET /api/sidebar/news`
Flash news feed for sidebar.

### `GET /api/posts`
Community posts. Supports pagination via `page` and `limit`.

Returns: `{ posts: [...], total: number }`

### `GET /api/library`
Library items (books/resources). Supports:
- `category` — filter by category
- `page`, `limit` — pagination

Returns: `{ items: [...], total: number }`

### `GET /api/library/:id`
Single library item detail.

### `GET /api/flash-news`
Real-time crypto news feed.
- `limit` — number of items (default: 20)

Returns: `{ news: [...] }`

## Authentication

Most read endpoints are public. Write operations require a Supabase auth token via `Authorization: Bearer <token>` header.

## Rate Limiting

API routes are rate-limited. Excessive requests will receive `429 Too Many Requests`.
