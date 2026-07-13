# 上线前穷尽审计 — 2026-07-11

8 路并行专项审计（支付/安全/法务/SEO/错误处理/运营/产品/承载），每条已逐条独立核实（误报剔除）。状态：✅已修 / 🔧我可修待做 / 👤需owner。

## ✅ 已修并推送（本轮）

| 项                                                                                                                                    | commit    |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| lifetime 退款白嫖双洞（不降级 + verify-session 重放）                                                                                 | 4bdf4425a |
| subscription-expiry plan=NULL 洞（过期订阅永不降级）                                                                                  | 261713af3 |
| /api/subscription pro-无订阅行 null 解引用 500                                                                                        | 261713af3 |
| **/api/og/trader 恒 500 → edge runtime 根治**（真因=next/og@16 nodejs pipe bug；~1412 分享卡；REST+edge base64 重写，生产同源验证中） | 6222c9e29 |
| /api/v3 platforms 全表拉 34k → warm 缓存                                                                                              | efa1171a7 |
| /sitemap.xml 404 → rewrite                                                                                                            | efa1171a7 |
| quiz_results 匿名可伪造 user_id 插入 → DROP 纵容策略                                                                                  | efa1171a7 |
| 4 个 error.tsx（saved 越组丢导航壳 + 3 叶子）                                                                                         | cd2bcbd95 |
| OTP 主注册补发欢迎邮件                                                                                                                | c542044f3 |
| .env.example 补 8 个活跃变量（治环境奇偶漂移）                                                                                        | 9e36baaa9 |
| R2 恢复脚本 + RUNBOOK 章节（治"只备不演练"，--list 已实测）                                                                           | e97b3ff68 |
| GO_LIVE 补切 live 前清理 test 订阅步骤                                                                                                | 2600a3558 |
| OG webp 头像 → 只嵌 PNG/JPEG（edge 后残留 500 真因，Satori 不解 webp）                                                                | 4a1fd1747 |
| recommendations content/groups 未登录 fallback 加缓存                                                                                 | 5d76efb21 |
| sitemap trader lastmod 用真实 computed_at（治 Google 忽略 lastmod）                                                                   | d8921cbf9 |
| apple-touch-icon.png 根路径别名（iOS 裸探测 404）                                                                                     | 07347ecb5 |
| 首页 ISR getHeroStats build-guard（待 build 复验）                                                                                    | 36dfe8135 |
| payment_failed 宽限+通知（不首次失败即降级）                                                                                          | de618fa36 |
| webhook 未知 price 白名单（不默认授 Pro）                                                                                             | be5120ef7 |
| 7天 trial 防重薅（Stripe 历史检查）                                                                                                   | a6539c2c4 |
| 6 个写型 SDF 收回 anon/PUBLIC EXECUTE                                                                                                 | 51e7988a0 |
| DB 容量哨兵（54.7GB 实测，阈值告警）                                                                                                  | 796ab8562 |
| 告警 P0/FYI 分层 + health-monitor GH 2h 去重                                                                                          | 0877f55b6 |
| haptics 触觉开关真接线（localStorage）                                                                                                | 541a4dc49 |
| repost test QA 垃圾帖删除                                                                                                             | (DB)      |
| trader 单一 canonical + sitemap platform 对齐                                                                                         | e9472c5fe |
| OAuth/钱包用户可自助删号（DELETE 确认）                                                                                               | 9cfbed47c |
| 退款政策统一 case-by-case + 邮箱统一 outlook + 隐私补 3 段披露                                                                        | e15e4e073 |

## 👤 P0 — 绑 Stripe 切 live，只有 owner 能拍

**生产库 2 条 test-mode 活跃订阅**（`sub_1StiFLCL…` user ebe2c2fb / `sub_1SujcrCL…` user ae6b996d，均 active/pro/plan=null，带 test `cus_`，到 2027）。切 live 当天连环爆：白嫖 Pro / 想付费被 409 挡 / 换 webhook secret 后取消事件签名失败到不了 / portal 用 test cus 500。**处置见 docs/STRIPE_GO_LIVE.md 新增「切 live 前清理 test 数据」步骤。**

## 🔧 P1 — 剩余(计划 A+B+C 后仍开放的)

| 项                                  | 状态 / 为何                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首页 ISR 失效                       | **✅已根治(07-12)**。双真凶:①getHeroStats 缺 build-guard(36dfe8135);②HomeHeroSSR/SSRRankingTable 经 getServerTranslation 读 cookies() → `/` 判动态(隔离 worktree `dynamic='error'` build 实锤 `used cookies()`)。修=getStaticTranslation(63d0aafaa,SSR 壳固定英文,客户端水合换语言,与"SSR 恒默认视图"决策同构)。**生产实证:cache-control: s-maxage=120,swr=600 / x-vercel-cache STALE/HIT** —— 宣传第一落点边缘缓存就位。期间连带修复 CI 四环阻塞(悬空导入/types漂移/build期env throw/schema 503 flaky) |
| help/pricing/status 首屏裸 i18n key | **✅已根治(f1248ea07)**:registerFullDict 路由 chunk 同步注册全量字典 —— 绕开 en-core 膨胀/dynamic 化/水合错配三个坑;dev 真点三页 SSR 零键名                                                                                                                                                                                                                                                                                                                                                             |
| api-docs 硬编码英文                 | **✅定价区已四语化(a7d95b48c)**:24 键 ×4 语 + registerFullDict;端点/参数技术文档按行业惯例留英文(有意)                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sentry sourcemap 未上传             | 正解在 Vercel 侧(SENTRY_AUTH_TOKEN 进 Vercel env + 构建期上传);CI 单独构建 hash 与部署对不上,错配比没有更糟 = owner 配 env                                                                                                                                                                                                                                                                                                                                                                              |
| market SSE 每观众占 58s nodejs 函数 | **已缓解(ae74cca19)**：实时成交卡仅在进入视口附近时才建连、离开即释放；端点补每 IP 10/min 独立建连限流及 abort 清理。仍非全局 fan-out：若市场页成为高流量入口，应另行建设由 worker 写 Redis 快照、客户端轮询的成交数据管道，再退役 Node SSE。 |

## 👤 需 owner 决定/去 Dashboard

- **Supabase auth 邮件模板**（没配=Supabase 品牌+发件域，第一封邮件不专业）
- **hreflang 死代码 + 四语同 URL**（搜索引擎只见英文，ja/ko/zh 零自然流量；根治需分语言 URL，产品级决策）
- **恢复演练从未做**（备份不含 auth schema=恢复出"有帖子没用户"）—— 我可写 restore 脚本+runbook，演练需 owner 在场

## 🔧 P2 — 非阻塞（有证据在案）

- 安全：~~quiz_results 匿名可插入~~(已修 efa1171a7) / 64 个 anon 可执行 SDF（含写型，需逐个核实纯触发器 vs 前端直调）/ trader_authorizations FOR ALL / CSP strict-dynamic 无 nonce / http 扩展在 public
- 运营：告警无 P0/FYI 分层+GH 侧去重失效（故障每 30min 轰炸）/ ~~env 奇偶漂移~~(已修 9e36baaa9)/ 容量红线零监控 / Meilisearch 永久关证书校验
- 产品：feed 首条是「repost test」QA 垃圾帖 / 8 种子小组无头像 / api-docs 硬编码英文 / 触觉反馈开关死代码
- 支付：payment_failed 零宽限期零通知 / 7天 trial 可无限重薅 / webhook 不处理 dispute / webhook 未知 price 默认授 Pro monthly

## 误报/已通过（核实后剔除）

- 安全 3 项：admin 路由"缺 verifyAdmin"实为 CRON_SECRET timing-safe / 新表 RLS 均 fail-safe / 无 SQL 注入拼接
- 产品"空社区"：/hot 30帖+8双语种子组+trending 侧栏有数据，被数据本身证伪
- 错误处理：93 个 error.tsx 全覆盖、超时层层设防、Redis 熔断+告警齐全（成熟度高）
