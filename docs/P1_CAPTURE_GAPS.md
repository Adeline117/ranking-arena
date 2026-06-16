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

## 进度(2026-06-15 实战)

- ✅ **blofin_futures + blofin_spot —— 已做并 end-to-end 验证**。live-harvest 看板
  `uapi/v1/copy/v2/trader/list`(无签名、worker 可达):每行带 roi/pnl/mdd/aum/
  sharpe_ratio/followers + roi 曲线。根因:publish headline upsert 只写 roi/pnl/
  win_rate。修复:`ParsedLeaderboardRow` 加 `headlineMdd/Sharpe/Aum/CopierCount/
Volume` + upsert 用 `COALESCE(EXCLUDED, existing)`(profile 源发 null 不被覆盖),
  blofin parser 回填。**验证**:重启 ingest worker(tsx 不热重载,必须重启)→ 强制
  Tier-A → DB:blofin_futures 1664×3 全部 mdd/sharpe/aum/copier 已填、spot 63-88 已填
  → 前端 witness:Crypto Vikings 显 Max Drawdown/Sharpe/AUM/Copiers + 回撤图。
- ✅ **bitfinex —— vol→volume 已做**(同 profile-less 看板回填模式,纯 HTTP 公开 API
  已抓 vol 看板)。随下次 worker 重启 + 抓取生效。
- ⏳ **bingx —— 签名 API,需逆向**。数据 API = `api-app.qq-os.com/api/...`,头里
  `appid=30004 / mainappid=10009 / timestamp / device_id(随机uuid) / sign(HMAC hex)
/ app_version=5.4.6 / traceid`。sign 由前端 JS 按 (参数+timestamp+device_id+密钥)
  算。两条路:(a) 从 JS bundle 提取 sign 算法;(b) 浏览器内驱动 SPA 让其自签 + 抓
  trader-list 响应(本轮还没定位到 trader-list 端点,只见 config/coin/permission)。
- 🛡️ **binance_web3 —— 202 反爬**(3 次尝试已耗尽),需新思路。

**通用模式(已验证)**:profile-less 的"看板即数据源"交易所 → 在 parser 把 board 行的
富字段塞进 `headline*` → publish headline upsert 用 COALESCE 写 trader_stats →
serving 富面板零改自动展示。**运维**:worker 用 `tsx`(不热重载)→ 改 lib 后必须
`pm2 restart arena-ingest-worker`;强制重抓 = 往 `arena-ingest-fast`(轻量源)/
`arena-ingest`(重型源)队列 `q.add('tiera:leaderboard', {sourceSlug}, {jobId 无冒号})`
(job NAME 是 `tiera:leaderboard`,slug 在 data —— 用 `tiera:<slug>` 当 name 会报
"unknown job")。

## 阻塞说明(诚实)

live harvest 必须在有实时浏览器 + 过反爬/地理封锁的环境(Mac Mini worker / SG VPS)
里做 —— 从开发环境盲写这些 SPA/签名/反爬端点的 parser 等于猜响应 shape。所以
**下一步是在 worker 上跑 harvest 探针拿真实响应**,再据此实现 parser(本仓库可写探针
脚本与 parser 骨架,但 fixture 必须实测产出)。

## 进度更新(2026-06-15 续 — bingx 也是看板回填,不是签名墙)

- ✅ **bitfinex vol→volume —— 已验证**(DB:tf7=77/tf30=145 traders 已填 volume,as_of 02:12 新鲜)。
- ✅ **bingx —— 实测推翻"签名墙"判断**:adapter **不是 stub**,早已"harvest 一条签名
  请求 + replayPaged 重放"(签名已解决),抓 roi/pnl/win_rate。本轮 live-harvest 确认
  trader-list 端点 = 点 "Smart Ranking" tab → `api-app.qq-os.com/api/copy-trade-facade/
v1/trader/search?pageId=&pageSize=&rankType=income&sort=accEarningRatio&order=desc`。
  其 `rankStat` 是**近乎全超集**:equity / strFollowerNum / maxFollowerNum /
  maxDrawDown{7,30,90}d / sharpe{7,30,90}d / winRate{tf}d / cumulativeProfitLoss{tf}d /
  totalEarnings / followerEarning / totalTransactions / profit/lossPositionCount /
  avgProfit / avgLoss / avgProfitRate / avgLossRate / pnlRate / avgHoldTime /
  weeklyTradeFrequency / tradeDays / lastTradeTime / latest30DaysMedianLeverTimes …
  已用 blofin 看板回填补 **mdd/sharpe/aum/copier_count**(commit 已推、worker 已加载、
  crawl 进行中——2076×3 harvest+replay 慢,~10min+)。
  **后续(高价值)**:把上面 rankStat 富字段(avgProfit/tradeDays/weeklyTradeFrequency/
  lastTradeTime/win&total positions/avgHoldTime…)写进 trader_stats 列/extras → bingx
  会变成最富的源之一。需扩 headline upsert 写 extras 或给 bingx 做 profile-pass。
- 🛡️ **binance_web3 —— 仍是 202 反爬**,本轮未碰,是剩下唯一真"墙"。

## 进度更新(2026-06-15 续2 — "两堵墙"都是红鲱鱼,全部攻下)

- ✅ **binance_web3 —— "202 墙"是红鲱鱼**。202 只挡 per-address **profile 页**,而我们根本
  不需要它:看板端点 `web3.binance.com/bapi/defi/v1/public/wallet-direct/market/
leaderboard/query?chainId=56&period=&tag=ALL`(**纯 GET、无签名、可达**)每行就带
  **完整 §2.5d 链上超集**:balance / realizedPnl(%) / winRate / totalVolume /
  buy&sellVolume / avgBuyVolume / totalTradedTokens / totalTxCnt / topEarningTokens /
  tokenDistribution / lastActivity / dailyPNL。roi/pnl/winrate 早已流;本轮补
  aum(balance)+volume(totalVolume)+extras(avg_buy/total_traded_tokens/total_txns/
  last_trade_time)+3 个链上 registry 指标。**DB 验证:tf7 = 318 traders 全部 aum/vol/
  tokens/txns/avg_buy/last_trade 已填**(as_of 02:47)。
- ✅ **bingx 富 extras —— 已验证**:tf7 = 2172 traders avg_profit/trades_per_week/
  trading_days/last_trade + 2231 mdd/sharpe/aum/copier(as_of 02:44)。前面没填是
  被我反复重启 worker 打断了抓取;让它跑完一次即落地。
- 🎯 **结论:全部"thin"源都已补富并 DB 验证**(blofin×2 / bitfinex / bingx / binance_web3)。
  **两堵"墙"(bingx 签名 / binance_web3 202)都是红鲱鱼**——adapter 早已解决签名
  (harvest+replay)/ 根本不需要 202 的 profile 页。富数据一直在**看板**上。
  剩余各源 tf30/90 随各自 cadence 抓取陆续补齐(代码已就位)。
