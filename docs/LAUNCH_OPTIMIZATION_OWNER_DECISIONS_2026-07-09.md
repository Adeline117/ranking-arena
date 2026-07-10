# 上线优化 — 待 owner 决策清单(2026-07-09)

8 角度审计 + agent team 已把**所有工程可做项**落地(见下"已完成")。本文件是**只有你能拍**的
决策/花钱项——代码开关我已备好,证据摆齐,你点头即可落地或翻转。

---

## ★ 穷尽审计新增(2026-07-10 · 9-agent 深审,比上轮深)—— 需你拍的 P1

| 项                                             | 证据                                                                                                                                                                        | 需要你                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **[Stripe live 前必修] lifetime 退款仍留 Pro** | `stripe/webhook/handlers/refund.ts:55` 对 lifetime 无条件跳过降级(注释说"仅当退的是 lifetime 才降"但没实现);`verify-session:103` 不查 refund,重放已退款 session 可重授 Pro  | 买 lifetime→退款→白嫖 Pro。若 Pro 门控空投资格则严重。**修法已备,随 Stripe live 一起上,待你确认** |
| **[承载] Upstash 放大**                        | 每 `/api/*` 现 2 次 Upstash 调用(我加的 IP floor + 分层限流);Upstash 自身饱和时**全部限流 fail-open** → 空投峰值最可能先崩的就是 Upstash,一崩全放行灌 DB                    | Upstash 提额 **或** 把 IP floor 挪到 Cloudflare 边缘(anti-hammer 底线不该依赖会饱和的东西)        |
| **[承载] 读副本休眠**                          | `SUPABASE_READ_REPLICA_URL` 在 `.env.production`/`.vercel.production`/`.example`/`.local` **全未设** → `getReadReplica()` 永远回主库,~11 个"已卸载"热读路由全打主库、零卸载 | 开 Supabase 读副本($)+ 设 env。代码路由已就位,配好即生效                                          |

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
**安全**:实测 RLS clean、subscriptions/trader_follows 已有 unique、6 群特权路由全已 re-check 角色、
feedback 已是 sensitive 限流——审计的安全项多为误报,底子硬。
**增长/留存**:个性化 feed(关注的人动态 Following/Discover 双 tab)、周报改 per-user、/learn OG+Article
JSON-LD、首页 ItemList 结构化数据、sitemap 防漂移、客户端 locale 自动探测(修 CJK 半英文)、
ReferralCard 三元翻译→t()(ja/ko 不再回落英文)。

> 方法学备注:8 个审计 agent 报的高优项里有**多个是误报**(死代码、已有 unique、已 re-check 角色、
> 已 sensitive 限流)——全靠"修前先核实"逐个 grep/查生产拦下,没盲改。真做的都是核实过的真项。
