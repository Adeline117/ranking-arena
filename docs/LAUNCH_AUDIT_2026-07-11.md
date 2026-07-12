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

## 👤 P0 — 绑 Stripe 切 live，只有 owner 能拍

**生产库 2 条 test-mode 活跃订阅**（`sub_1StiFLCL…` user ebe2c2fb / `sub_1SujcrCL…` user ae6b996d，均 active/pro/plan=null，带 test `cus_`，到 2027）。切 live 当天连环爆：白嫖 Pro / 想付费被 409 挡 / 换 webhook secret 后取消事件签名失败到不了 / portal 用 test cus 500。**处置见 docs/STRIPE_GO_LIVE.md 新增「切 live 前清理 test 数据」步骤。**

## 🔧 P1 — 我可修

| 项                                                      | 证据                                                    | 状态                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 首页 ISR 失效（每 PV SSR+MISS，宣传第一落点零边缘缓存） | curl `private,no-store`+MISS；prerender-manifest 无 `/` | ⏸ 明显嫌疑全排除，根因需 build-time 静态化报告定位；本机=生产worker，全量build有OOM饿死ingest风险，留CI/preview |
| recommendations content/groups 未登录裸打 DB            | 无缓存/无 s-maxage                                      | 🔧 加缓存头                                                                                                     |
| Sentry sourcemap 未上传（首周排障只能猜 digest）        | next.config 注释说 CI 传，实际无                        | 🔧 补 CI job                                                                                                    |
| market SSE 每观众占 58s nodejs 函数                     | ws/market/route.ts nodejs+58s 重连                      | 🔧 峰值降级轮询（较大改动，评估）                                                                               |
| help/about/pricing 首屏渲染裸 i18n key                  | 不在 en-core 的 key SSR 显示键名                        | 🔧 收进 en-core                                                                                                 |
| SEO 重复 URL（trader 两个自 canonical）                 | sitemap slug ≠ 内链全址                                 | 🔧                                                                                                              |
| sitemap lastmod=请求时刻（Google 判不可信忽略）         | 1458 条同毫秒时间戳                                     | 🔧                                                                                                              |

## 👤 需 owner 决定/去 Dashboard

- **Supabase auth 邮件模板**（没配=Supabase 品牌+发件域，第一封邮件不专业）
- **法务退款政策四处矛盾**（case-by-case vs 7天无条件 vs 仅年付）+ **support@arenafi.org 是否真收件**（法务页已统一 outlook，退款FAQ/页脚仍 support@）
- **隐私政策漏披露**：交易所 API key 存储 + 34k 被抓取交易员（GDPR Art.14）+ Sentry
- **OAuth/Web3 用户无法自助删号**（DeleteAccountModal 强制密码，Privy/OAuth 无密码；ToS 承诺"随时可删"）
- **hreflang 死代码 + 四语同 URL**（搜索引擎只见英文，ja/ko/zh 零自然流量；根治需分语言 URL，产品级决策）
- **恢复演练从未做**（备份不含 auth schema=恢复出"有帖子没用户"）—— 我可写 restore 脚本+runbook，演练需 owner 在场

## 🔧 P2 — 非阻塞（有证据在案）

- 安全：quiz_results 匿名可插入+伪造 user_id / 64 个 anon 可执行 SDF（含写型）/ trader_authorizations FOR ALL / CSP strict-dynamic 无 nonce / http 扩展在 public
- 运营：告警无 P0/FYI 分层+GH 侧去重失效（故障每 30min 轰炸）/ env 奇偶漂移（链上keys/Meili/read-replica/Stripe price 不在 .env.example）/ 容量红线零监控 / Meilisearch 永久关证书校验
- 产品：feed 首条是「repost test」QA 垃圾帖 / 8 种子小组无头像 / api-docs 硬编码英文 / 触觉反馈开关死代码 / apple-touch-icon 根路径 404
- 支付：payment_failed 零宽限期零通知 / 7天 trial 可无限重薅 / webhook 不处理 dispute / webhook 未知 price 默认授 Pro monthly

## 误报/已通过（核实后剔除）

- 安全 3 项：admin 路由"缺 verifyAdmin"实为 CRON_SECRET timing-safe / 新表 RLS 均 fail-safe / 无 SQL 注入拼接
- 产品"空社区"：/hot 30帖+8双语种子组+trending 侧栏有数据，被数据本身证伪
- 错误处理：93 个 error.tsx 全覆盖、超时层层设防、Redis 熔断+告警齐全（成熟度高）
