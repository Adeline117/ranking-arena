# Arena CF Worker Patterns

Cloudflare Worker 代理模式，绕过交易所 API 的 CF/geo 拦截。

## Worker 位置
- 代码: `cloudflare-worker/src/index.ts`
- URL: `https://ranking-arena-proxy.broosbook.workers.dev`
- 部署: `cd cloudflare-worker && CLOUDFLARE_API_TOKEN=xxx npx wrangler deploy`

## 已实现路由

| 路由 | 目标 | 状态 |
|------|------|------|
| `/health` | 健康检查 | ✅ |
| `/proxy?url=` | 通用代理 | ✅ |
| `/binance/copy-trading` | Binance | ✅ |
| `/bingx/leaderboard` | BingX | ✅ |
| `/bingx/trader-detail` | BingX | ✅ |
| `/blofin/leaderboard` | BloFin | ✅ |
| `/blofin/trader-info` | BloFin | ✅ |
| `/gains/leaderboard-all` | Gains Network | ✅ |
| `/gains/open-trades` | Gains Network | ✅ |
| `/gains/trader-stats` | Gains Network | ✅ |
| `/dydx/leaderboard` | dYdX | ✅ |
| `/dydx/historical-pnl` | dYdX | ✅ |
| `/dydx/subaccount` | dYdX | ✅ |

## 添加新路由模式

```typescript
// 在 fetch handler 里加 shortcut
if (url.pathname === '/newexchange/endpoint') {
  return handleNewExchange(request, url);
}

// handler 函数
async function handleNewExchange(_request: Request, url: URL): Promise<Response> {
  const param = url.searchParams.get('param') || 'default';
  const apiUrl = `https://api.newexchange.com/endpoint?param=${param}`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
```

## 降级策略

```
1. 直连 API（Mac Mini 住宅 IP，部分能过）
2. CF Worker 代理（不同 IP，Smart Placement）
3. VPS 代理（新加坡/日本 VPS）
4. Puppeteer（最终手段，处理 JS challenge）
```

## 踩坑

- Worker 代码更新后必须 `wrangler deploy`，否则还是旧路由
- Smart Placement 让 CF 自动选最优 edge，但不保证绕过 geo-block
- Gains API 429 很频繁，即使走 Worker 也会被限
- `/proxy?url=` 通用路由只转发 GET，POST 需要单独写 handler
