# 上线优化 — 待 owner 决策清单(2026-07-09)

8 角度审计 + agent team 已把**所有工程可做项**落地(见下"已完成")。本文件是**只有你能拍**的
决策/花钱项——代码开关我已备好,证据摆齐,你点头即可落地或翻转。

---

## ★ 穷尽审计新增(2026-07-10 · 9-agent 深审,比上轮深)—— 需你拍的 P1

| 项                                          | 证据                                                                                                                                                                        | 需要你                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[已修 2026-07-11] lifetime 退款仍留 Pro** | `stripe/webhook/handlers/refund.ts:55` 对 lifetime 无条件跳过降级(注释说"仅当退的是 lifetime 才降"但没实现);`verify-session:103` 不查 refund,重放已退款 session 可重授 Pro  | 买 lifetime→退款→白嫖 Pro。**已修**:refund.ts 回查 checkout session 判定 lifetime 购买后降级(判定不了 error 留痕人工跟进);verify-session 核对 charge 退款态拒重放。PRO_FREE_PROMO 期间零影响,Stripe live 即生效 |
| **[承载] Upstash 放大**                     | 每 `/api/*` 现 2 次 Upstash 调用(我加的 IP floor + 分层限流);Upstash 自身饱和时**全部限流 fail-open** → 空投峰值最可能先崩的就是 Upstash,一崩全放行灌 DB                    | Upstash 提额 **或** 把 IP floor 挪到 Cloudflare 边缘(anti-hammer 底线不该依赖会饱和的东西)                                                                                                                      |
| **[承载] 读副本休眠**                       | `SUPABASE_READ_REPLICA_URL` 在 `.env.production`/`.vercel.production`/`.example`/`.local` **全未设** → `getReadReplica()` 永远回主库,~11 个"已卸载"热读路由全打主库、零卸载 | 开 Supabase 读副本($)+ 设 env。代码路由已就位,配好即生效                                                                                                                                                        |

## ★ Upstash 限流 3 跳 —— 有意未动(安全 > 省调用),留给压测+Upstash 提额

launch 审计发现每 /api/\* 请求 3 次 Upstash 限流 round-trip(proxy ipFloor 600/min + proxy 分层
read 120/min + route-level)。**核实后有意不减层**:每种减法都换来削弱——去掉分层则无 route-level 的
读路由(如 hero-stats,已 CDN 缓存 1h)从 120→600/min;去掉 ipFloor 则分层 fail-open 时无兜底。空投前
削弱滥用防线换取有限省调用 = 错误取舍。真正的 Upstash 承载杠杆 = **提额(owner-gated $)**;流式端点
的最大放大器已修(prices SSE 每实例 memo)。此项按 Phase D"压测再动"原则,待 k6 数据 + Upstash 档位决策。

## ★ 评分跨板公平性 —— 缺 execution 支柱的板可只凭 2 支柱冲到 ~99(需你拍方法学)

**实测生产(2026-07-10)**:served `arena_score` 已 = v4(29030/31952 行,UI 解释与值一致 ✓,
非新不一致)。但 **execution_score(一致性支柱)在无 trades_count 的板恒 null** —— 跨 15+ 源:
`okx_web3_solana` 6154 行中 1927 null(max 99.8)、`hyperliquid` 1416 null(max 100)、`bybit_mt5`
588、`gate_cfd` 553…。v4 里一致性权重仅 10%,缺失时**不惩罚**,故链上/无成交板交易员可只凭
盈利+风控两支柱冲到 ~99,而全数据 CEX 交易员按三支柱评。**这是跨板可比性/信任问题**(空投级
到访会拿链上 100 分号和 CEX 90 分号直接比)。

- **显示层已优雅**:三支柱条 null 时**隐藏**该条(ScoreBreakdown.tsx:161),非显 0/坏条;雷达图
  该轴回落 0(极轻微)。所以不是"看着像 bug",是**方法学是否公平**的实质问题。
- **需你拍**:缺 execution 时(a)维持现状(不惩罚,earnings-heavy 本就你定的方向)、(b)按缺失
  支柱降权/标注"数据有限"、(c)对无成交板用替代一致性代理(如链上持仓周期方差)。**改评分=重排
  全站,最高风险,不自主动。** 另:8 个板(bots/mt5/cfd/web3)走独立 compute 路径,arena_score_v4
  影子列未写(纯内部审计列,无 UI 读,无用户影响),可顺带在切换时对齐。

## ★ 加密模块统一(per-user 密钥)—— 需你批一次凭据重加密迁移

本轮已修**正确性**根因(verify-ownership 格式错配 + sync 密码列错位,见下"已完成"),
但**未做**把 3 个加密模块(`lib/exchange/encryption`、`lib/crypto/encryption`、
`lib/exchange/secure-encryption`)收敛成单一模块 + 引入 per-user 密钥。原因:per-user 密钥
意味着**重加密所有存量已连接交易所凭据**(读旧密钥解、写新密钥),是一次有数据迁移风险的
独立工程,不宜上线前自主做。现状已自洽可用(写读同模块),此项为**加固**非**修 bug**。
需你批:是否排期做单模块 + per-user 密钥迁移(要一个离线重加密脚本 + 回滚预案)。

## ★ 次级面深审新增(2026-07-11 · portfolio/alerts/groups/feed)—— 需你拍/排期

已修(本轮直接落地):发帖到群补成员/封禁/禁言/解散门禁(**P1 安全**:service-role 绕 RLS,任何人可往
私有/已解散群注入帖子)、退群仅真删时减 member_count(P2)。以下待你拍:

| 项                                                      | 证据                                                                                                                                                                                                                                                                                                 | 决策                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **[P1 信任] 3 个 Pro 告警类型静默永不触发**             | `AlertConfig.tsx` 有 Arena Score / Price Above / Price Below / New Position 开关且入库,但 cron `check-trader-alerts` 只评估 roi/drawdown/score/pnl/rank,**无价格源、无 positions 源**;score_change 结构性死(snapshot 硬置 arena_score=undefined)。用户开"BTC>$X 提醒"→ 无错、永不通知 = 付费退款隐患 | 要么实现(需价格源+持仓源+写 arena_score 进 snapshot),要么**先隐藏这些开关**(我可做,但涉及 AlertConfig 多开关手术,建议你确认方向再动) |
| **[P2] 组合"Total Equity"显名义敞口(被杠杆放大)**       | `portfolio/page.tsx:219` = Σ(size×mark)=名义,非账户权益;10x 杠杆→10x 虚高。sync 已取真实 balance 却没用                                                                                                                                                                                              | portfolio 当前 0 行(未上线),改动前先定权益口径(建议 balance+uPnL);标签改"Position Value/Exposure"                                    |
| **[P2] 权益曲线混两种口径 + 同日多次 sync 重复计**      | sync 写 balance、cron 写名义到同列;snapshots API 按天 sum 所有行且无 unique(portfolio_id,day)→ 点 5 次 sync = 当日 5×。未上线                                                                                                                                                                        | 统一口径 + 加 unique + upsert + 取每日最新行                                                                                         |
| **[P2] "30 天可恢复"误导**                              | `account/delete` 立即硬删 follows/alerts/2FA/bookmarks;recover 只清 deleted_at → 恢复到空账户                                                                                                                                                                                                        | 要么软删关联行,要么改文案(仅账户访问可恢复,内容立即移除)                                                                             |
| **[P3] 过期 Pro 告警仍发**                              | cron 不 join subscriptions,Pro 失效后告警行仍 enabled 持续发                                                                                                                                                                                                                                         | cron 过滤当前 Pro / 订阅到期 cron 关告警                                                                                             |
| **[P3] 书签乐观更新用 snapshot-capture(违 delta 铁律)** | `usePostActions.ts:447` 兄弟 toggleReaction 已改 delta,书签没改                                                                                                                                                                                                                                      | 改 delta 反转                                                                                                                        |
| **[P3] 被封禁用户仍可评论**                             | `comments/route.ts:128` 查 mute 未查 group_bans                                                                                                                                                                                                                                                      | 加 group_bans 查                                                                                                                     |
| **[P3] 死码 hooks 响应形状错 + 禁用回滚模式**           | `lib/hooks/usePostInteraction.ts`(index.ts 导出)无消费者,解析 data.comments(真形状 data.data.comments)+ snapshot 回滚                                                                                                                                                                                | 删除防误用                                                                                                                           |

## ★ settings/admin 深审新增(2026-07-11)—— 已修核心 + 待你定方向

**已修上线**:改密码后真实登出其他设备(原写死表 `login_sessions`,真实 refresh token 不失效 →
改 `supabase.auth.signOut({scope:'others'})`);admin stats/users/reports 三大 tab 读对响应形状
(原读 `data.ok` 恒"加载失败");DashboardTab CSV 导出崩溃 guard。

**待你拍(功能未接线,方向 = 实现 vs 隐藏假 UI):**

- **2FA / 备份码"假安全"(P1)**:`verifyTotpCode` 仅 enrollment 调、**无任何登录路径验证**;
  `verifyBackupCode` 零调用;SecuritySection 显绿色"已启用"实际零保护(生产 0 用户,未上线)。
  → 要么接入登录流(中大工程)/迁 Supabase 原生 MFA,要么**隐藏 UI 别显假"已启用"**(假安全比没有更糟)。
- **会话列表/"登出其他设备" UI 假的(P1)**:`login_sessions` 从不 INSERT、无 middleware 读 `revoked`;
  列表恒空。→ 实现真会话追踪 或 隐藏列表(改密登出已用 Supabase 全局登出兜住最关键场景)。
- **passwordless 用户无法禁用 2FA(P2)**:disable 走 `signInWithPassword`,无密码用户锁死 → 接受 TOTP/备份码替代。
- **2 监控面板 401(P2)**:MetricsTrends/EnrichmentCompleteness 发用户 JWT 但路由只认 CRON_SECRET → 改 `verifyAdminAuth`;运维面板,改 auth 宜谨慎。

## A. 变现(卡真实收入,最高优先)

| 项                          | 现状                                      | 需要你                                                                                                                                           |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stripe live 密钥**        | 生产跑 `sk_test_` 沙盒,真实用户从没付过款 | 提供 `sk_live_` + 各档 `STRIPE_*_PRICE_ID`(含 lifetime)配到 Vercel 生产 env。清单见 `docs/STRIPE_GO_LIVE.md`。代码 env-driven ready,配好即生效。 |
| **PRO_FREE_PROMO 翻转时机** | `lib/types/premium.ts` = true,全员免费    | 定 promo 结束日。翻转前建议先上"Pro·免费内测中"标注(见 D),否则一夜起墙=拔地毯,退款/流失风险高。                                                  |

## B. 品牌 / 文案(影响首因信任,低成本高信任回报)

| 项                            | 证据                                                                                                                                                 | 建议改法(待你批)                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **交易所数字自相矛盾**        | layout "45+" / methodology "25+" / hero 27 / 真实去重~18                                                                                             | 你此前拍板保留 45+(源数)。但同站 25+/27 与之打架 → **至少统一到一个口径**(留 45+ 源数 or 全改 27),别三个数并存。            |
| **beta 横幅攻击可信度**       | "Arena is in closed beta — **data is being updated**" 对万级到访直接暗示"别信这些数"                                                                 | 软化为 "Early access",去掉 "data being updated"。已有 `NEXT_PUBLIC_HIDE_BETA_BANNER` 开关。                                 |
| **pricing 促销期仍硬卖 Pro**  | 首页喊"全免费",/pricing 仍显"升级 Pro"+"200 席·永不再有"紧迫横幅(`PricingPageClient.tsx:257-290/870/898`)= bait-and-switch(首页已隐藏、pricing 没跟) | 促销期门控 `!PRO_FREE_PROMO`,改"促销后价格,现在免费"。                                                                      |
| **护城河没讲清("你超过 X%")** | v4 显示分本就≈"跑赢全体百分位",但 hero/榜单只显裸 0-100 数字,没说是跨所百分位                                                                        | hero + 榜头加"你超过了 34,000 名交易员中的 X%" + 一句"跨 35 所排名,无交易所付费置顶"(中立性)。这是最便宜的差异化+信任双赢。 |
| **免费层 alert 额度**         | 600 行 alert 引擎已建但 100% Pro-gated → 免费用户零回访理由                                                                                          | 给免费层 1-3 个免费 alert(如关注交易员的分数/排名变化),高级/无限留 Pro。纯配置。你定额度。                                  |

## C. 基建 / 花钱(万级承载)

| 项                         | 证据                                                                                     | 需要你                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **读副本可能没配**         | `getReadReplica()` env 未设则静默回主库,仅 ~4 用户路径用它;主库 PostgREST 100 连接是硬墙 | 核实 `SUPABASE_READ_REPLICA_URL` 生产真有;若没有,开读副本($)把热读卸载。 |
| **Upstash 提额**           | Redis 单点:缓存+限流+锁+心跳全靠它;万级下最可能先抖                                      | 评估 Upstash 付费档提请求上限,给冗余。                                   |
| **第二 worker / VPS 磁盘** | ingest worker = Mac Mini + SG VPS(95% 磁盘,近满);半手动 failover                         | 近期:VPS 清盘(我可加磁盘哨兵)。结构:第二 box 或云 runner($)。            |

## D2. 新发现:首页 HTML 未被 CDN 缓存(需架构评估,勿盲改)

实测 `/` 返回 `private, no-store`(非 vercel.json 的 `s-maxage=120`)→ **首页 HTML 不进 CDN**,
每次到访打 origin/serverless。根因:`HomeHeroSSR`/`SSRRankingTable` 走服务端 i18n(`cookies()` 读
language)→ 整个路由被判定为动态渲染 → Next 强制 no-store,盖掉 vercel.json 头。

- **先核实严重度**:动态渲染 ≠ 一定打 DB——首页数据大概率走 unstable_cache/Redis(revalidate=300),
  那么动态渲染只是多一次 serverless 调用、不碰 DB,影响小得多。上线前应先量首页在负载下是否真打 DB。
- **修法是权衡**(勿盲改,我刚因边缘层盲改冻结过管道):①单语英文可缓存 SSR 壳 + 客户端本地化
  (伤 SSR i18n/SEO,与刚做的 locale 探测冲突)②per-language CDN 变体(复杂)③接受动态首页但确保
  数据层重缓存(最务实)。**建议先量、再选,别硬切。**
- **★ 已实测(2026-07-10,保守 k6:30 VU/28 req/s/0% 错)**:首页 **519/519 全 cache MISS**、
  p95 **~1.07s**(而榜单/交易员 API 已缓存且快:traders 中位 100ms、rankings p95 524ms)。
  完整脚本 `scratchpad/k6-safe-cache-probe.js`,可加大 VU 复跑。
- **★★ 严重度已核实(降级)**:首页虽 HTML 不进 CDN,但其数据**读 Redis 不打 DB**——
  `getInitialTraders` 有双层 Redis 缓存(2h + 4h 兜底)、`getHeroStats` 也 Redis 缓存。故动态渲染
  每次是 serverless 调用 + Redis 读,**不是 DB 命中**。~1s p95 是 serverless 渲染成本,非 DB。
  **结论:这是【中等】问题(serverless 调用 + Redis 负载放大,喂给 Upstash 单点),不是 DB 熔断 P0。**
  真正的连带风险是每次首页访问都加 1-2 次 Redis 读 → 放大 Upstash SPOF 负载(见 C.Upstash 提额)。
  修法优先级相应下调;万级前建议先做 Upstash 提额(便宜)再考虑首页 CDN(架构权衡,别硬切)。

## D. 需先压测再动(不盲调,plan 已约定)

- **force-dynamic → ISR/CDN 缓存的具体清单**(168/311 路由无 CDN 缓存):需 k6 spike 打 preview 到万级,定位真拐点再逐路由转,避免误缓存个性化路由。
- **Redis fail-open 降级阈值**(缓存塌单机+限流蒸发的级联):需压测定位降级策略参数。
- 我可以起 k6 spike 场景打 preview + 盯 `/api/health/supabase-pool`,拿到数据再来找你定这两项。

---

## 已完成(本轮工程落地,无需你操作,仅告知)

**信任/正确性**:删死代码 trader-transforms(审计"最大信任洞"实为死代码陷阱,详情/compare 一直是 v4)、
trades=0 当未知不再压低合法源、主榜 >0 过滤对齐 live。
**弹性/可靠性**:SEV1 GitHub-issue 告警备份(Telegram 单点兜底)、edge 全局 IP 限流兜底(fail-open)。
**安全(Phase C 已落地)**:评论改软删(3 小号不再永久删真评论,可恢复可审计)、频道加人套
check_dm_permission(拉黑/禁DM者不可被强拉群发)、曝光量唯一索引+原子 RPC 去重(防刷榜)、
群 mute 改 sendNotification(铁律)、删免费 /api/tip(客户端定额无扣款=伪造打赏)、block/unblock
补 CSRF 双提交、**交易所同步凭据解密两处根因**(verify-ownership 格式错配→sync 解成垃圾;bitget
passphrase 列错位→sync 读错列永远无 passphrase);迁移 20260710015607/015608 已应用生产+types同步。
实测 RLS clean、subscriptions/trader_follows 已有 unique、6 群特权路由全已 re-check 角色、
poll-vote 已有限流、feedback 已是 sensitive 限流——部分审计安全项为误报,已核实拦下。
**i18n(Phase E)**:hot/pricing/channels 静态 metadata 去中文、RecentActivity/ApiKeys 日期按语言、
ConversationsList 死 fallback 清理(键四语已全)。
**增长/留存**:个性化 feed(关注的人动态 Following/Discover 双 tab)、周报改 per-user、/learn OG+Article
JSON-LD、首页 ItemList 结构化数据、sitemap 防漂移、客户端 locale 自动探测(修 CJK 半英文)、
ReferralCard 三元翻译→t()(ja/ko 不再回落英文)。

> 方法学备注:8 个审计 agent 报的高优项里有**多个是误报**(死代码、已有 unique、已 re-check 角色、
> 已 sensitive 限流)——全靠"修前先核实"逐个 grep/查生产拦下,没盲改。真做的都是核实过的真项。
