# P1 抓取缺口 — 富数据「在页面上、我们没抓」的来源清单

> 纠错记录(2026-06-15):前端审计一度把这些源判成「交易所给得少」。**错。**
> 权威 `交易所细节.docx` 截图证明:这些源的**交易员主页有大量富数据**(多时间段
> Performance / Positions / Trades / Copiers / 链上 token 级)。`arena.trader_stats.extras`
> 为空是因为**我们的 adapter profile parser 是 stub / 被延后 / 被反爬挡**,不是交易所薄。
> 前端(serving 富面板)已就绪,会 NULL-collapse —— **一旦这些 adapter 补上抓取,
> 前端零改动即自动变富**(见 §6 metric-registry + serving panel)。

## 现状(逐 adapter 实证)

| 源                      | profile parser           | 证据(adapter header / 代码)                                                                | docx 说页面有什么                                                                                                | 阻塞类型              |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------- |
| **okx-web3**            | ✅ 真实(13 extras)       | `priapi/.../pnl/wallet-profile/summary` 纯 HTTP                                            | 上半多时段 + 下面逐 token                                                                                        | — (模板)              |
| **blofin_futures/spot** | ❌ stub→`{stats:[],...}` | index.ts「SPA-route-gated… future work」                                                   | 主页 Performance(7/30/90 全细节)+ Trades(Current Positions/Trade History)+ Bots + Copiers                        | 延后,**从未 harvest** |
| **bingx_futures/spot**  | ❌ stub                  | 「signed SPA routes not yet harvested (future work)」                                      | Perpetual/Standard/Spot ×(Overview/Positions/Trades/Copier Data/Transfer Records),「八个按钮每个大量模块多时段」 | 延后,**从未 harvest** |
| **binance_web3_bsc**    | ❌ stub                  | 「address page 202 challenge,no public profile XHR,**3 approaches exhausted 2026-06-12**」 | active positions / realized PnL / transaction history / 可复制地址 / token 级                                    | **反爬**(202 挑战)    |
| **bitfinex**            | ❌ stub                  | 公开 API 比网页给更多(持仓+盈亏)                                                           | 通过 `api-pub.bitfinex.com` rankings hist 反推持仓/多空(bfxleaderboardTracker)                                   | 推断复杂度            |

> 其余 32 个源的 profile 都已真实抓取(mexc 16 extras 含能力雷达/持仓分布、
> bybit/gate/htx/coinex/bitget/bitmart/btcc/bitunix/xt/kucoin/lbank/phemex/gmx/gtrade…)。

## 各源该抓的字段(docx §2 超集对照)

- **blofin**(`https://blofin.com/copy-trade/futures?tab=allTraders` → 交易员主页):
  Performance 多时段(roi/pnl/win_rate/mdd/sharpe… 右上角切 7/30/90)、Trades→Current
  Positions + Trade History(翻页抓全)、Bots、Copiers。
- **bingx**(`https://bingx.com/en/CopyTrading`):Perpetual/Standard/Spot 三类,每类
  Overview(多时段统计)+ Positions + Trades + Copier Data + Transfer Records。
- **binance_web3_bsc / okx_web3**(链上,§2.5d):total_balance · total_trades ·
  total_traded_tokens · realized_pnl(+PnL 日历)· win_rate 分布桶 · volume · avg_buy ·
  txns · top_earning_tokens · token_distribution;记录区 Active Positions / Realized
  PnL / Transaction History;**地址可复制**。(okx_web3 已抓,binance_web3 待破 202。)
- **bitfinex**:`v2/rankings/{key}:{period}:tGLOBAL:USD/hist` 历史 pnl 序列 → 派生
  多空/仓位调整(参考开源 bfxleaderboardTracker)。

## 做法(每源相同节奏)

1. **live harvest**(必须在能出墙 + 过反爬的 worker / VPS 上跑):打开 docx 的交易员
   主页 URL,抓真实 XHR/JSON 响应,存成 `__tests__/fixtures/`。**不能盲写 parser**
   —— 响应 shape 必须来自实测,否则是猜。
2. 仿 **okx-web3** 把 `getProfile/getPositions/getHistory` 从 stub 改成真实 fetch +
   `parse<X>Profile` 写 `extras`(覆盖上面字段),`getHistory` 游标翻页到底。
3. 跑该 adapter parser 测试(fixture 驱动)→ worker 重启 → 下次 tier-B 入库 →
   serving 面板自动变富(前端零改)。
4. blofin/bingx 优先(只是延后,未试过);binance_web3 需先解 202 挑战(第 4 种思路);
   bitfinex 做 hist→持仓反推。

## 阻塞说明(诚实)

live harvest 必须在有实时浏览器 + 过反爬/地理封锁的环境(Mac Mini worker / SG VPS)
里做 —— 从开发环境盲写这些 SPA/签名/反爬端点的 parser 等于猜响应 shape。所以
**下一步是在 worker 上跑 harvest 探针拿真实响应**,再据此实现 parser(本仓库可写探针
脚本与 parser 骨架,但 fixture 必须实测产出)。
