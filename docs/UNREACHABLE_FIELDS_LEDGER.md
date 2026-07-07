# 拿不到字段对账台账(Unreachable Fields Ledger)

> 逐个"墙"的实测结论。2026-07-01 全部重新活体验证/攻克(SG live probe + 生产直查 +
> 自派生)。区分**真墙**(数据源侧限制,活体证据)与**假墙**(我之前误判,已攻克)。

## 假墙 — 已攻克/本就不是缺口

| 项                                    | 之前误判          | 真相 + 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **okx_web3**                          | "已退役"          | ❌ 错。退役的是旧 slug；活的是 `okx_web3_solana`(23,730 交易员、13 链上字段:txs_buy/sell、volume_buy/sell、avg_cost_buy、native_balance、unrealized_pnl、win_rate_distribution、top_tokens_total_pnl…、今日仍更新)。**在库正常流动。**                                                                                                                                                                                                                                                   |
| **OKX/bitunix/xt/mexc/bitget Sharpe** | "公开 API 不返回" | ⚠️ **2026-07-02 已撤销自派生**。原写「自己算 ~1.1 万」已过期:`publish.ts:30` `SELF_DERIVE_RISK_SOURCES` 现仅 DEX(hyperliquid/gmx/gtrade),CEX 一律「抓真值或诚实留空」(user directive 2026-07-02,日近似冒充交易所精度会失真)。**处置**:bitget/okx/bitunix/xt 上游不提供 Sharpe → honest-NULL by policy(真墙);现库里 bitunix(71%)/xt(79%)的 `extras.sortino` 是关闭前残留、非在跑。**mexc 例外**:`EXCHANGE_FIELD_MAPPING.md` 声称返回 `sharpeRatio`,待抓 live payload 裁决(见 Phase 1.3)。 |
| **Blofin Sortino/波动率**             | "SPA 无端点"      | ✅ **改为抓真值**(不再自派生)。blofin profile 经 unsigned uapi stat 端点可达(`adapters/blofin`),`series-risk.ts:340` 已将 blofin 移出 self-derive。实测 blofin_futures sharpe 100% / blofin_spot 95%——真值直抓,非派生。                                                                                                                                                                                                                                                                  |
| **HTX followers**                     | "登录门控"        | ❌ 非真缺口。copier_count(798 行,最多 923)+ copier_pnl **已抓**。门控的只是**私密 copier 身份名单**——所有交易所都不公开,产品也不展示单个跟单人身份。有意义的跟单指标齐了。                                                                                                                                                                                                                                                                                                               |

## 真墙 — 数据源侧限制(活体证据)

| 项                            | 活体证据(2026-07-01)                                                                                                                                                                                                                                                                                                       | 性质                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **CoinEx 板**                 | 无参数调用 `code:0 Success total:0`;**真浏览器**打开 `/en/copy-trading/traders` 直接 302 重定向到首页 `/en`,0 XHR——跟单页本身已下线。                                                                                                                                                                                      | 上游停服(真浏览器复核 2026-07-01)。不可恢复。        |
| **Gate CFD 当前仓位/划转**    | 端点 WAF `Access Denied`(裸请求),需 auth-gated 内部 user ID。板级指标(1328 交易员+自派生 sharpe/sortino/波动率)齐。                                                                                                                                                                                                        | 短暂性+私密明细 auth 门控。核心已覆盖。              |
| **binance_web3 profile 明细** | board 公开可用(富数据)。**真浏览器实证 2026-07-01**:headless Chromium 打开钱包详情页,拦截到的全是 `*.awswaf.com` 托管挑战(token/mp_verify),UA=HeadlessChrome 被 AWS WAF 识别并持续挑战,真实 profile XHR 不放行。人眼可见=真人非-headless 浏览器不被标记。绕过需 stealth/headful+xvfb/住宅代理(arms-race、脆弱、ToS 灰区)。 | 主动反自动化(AWS WAF)。board(Tier-A)已覆盖排名指标。 |
| **Bitget 余额历史**           | live SG 实测:UTA profile 仅总览/订单/跟单者/勋章,余额历史 tab **已从站点移除**(用户截图为旧版 classic UI)。                                                                                                                                                                                                                | 交易所下线该功能。                                   |

## 原则

- **"拿不到"必须有活体证据**(SG live probe / 生产 total:0 / 202 challenge),不凭先验断言。
- **自派生仅限纯 DEX**(hyperliquid/gmx/gtrade,链上无交易所值可抓)。**CEX/blofin 一律抓真值或诚实留空**(user directive 2026-07-02):交易所页面有真 Sharpe,日近似冒充会失真。撤销了早期「一律自己算」的做法。
- **私密/短暂明细**(单个跟单人身份、他人实时仓位)非产品需求,auth 门控不算缺口。
- 自派生值一律标 provenance(`risk_self_derived` / `risk_derivation='daily-approx'`),UI/评分不当交易所精度。
