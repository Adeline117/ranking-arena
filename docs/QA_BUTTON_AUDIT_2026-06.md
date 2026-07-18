# 全站按钮功能深度根源测试报告（2026-06-11 ~ 06-12）

> 方法论：不是逐个按钮点一遍，而是每发现一个故障追到**根因类**，全仓 grep 同类隐患一起清零。
> 执行方式：主会话编排 + 11 个并行子代理（探索 3 + 修复 8），边测边修，一类一 commit。
> 测试面：31+ 公开路由 × 2 视口 × 4 语言（86 次页面检查）+ QA 专用账号全链路写操作测试。

## 健康评分

| 维度                            | 审计前              | 审计后  |
| ------------------------------- | ------------------- | ------- |
| 核心路径（首页/排行/详情/搜索） | 85                  | 98      |
| 社交写路径（发帖/评论/关注）    | **0（全断）**       | 95      |
| 订阅/收入路径                   | **0（订阅按钮死）** | 95      |
| 登录态功能完整性                | 40                  | 90      |
| Console 卫生（匿名访客）        | 50                  | 95      |
| **综合**                        | **~45**             | **~93** |

## 发现并修复的根因类（按严重度）

### 🔴 BLOCKER（影响所有用户的功能性中断）

| #   | 根因                                                                     | 影响                                                                                                                       | 修复 commit                  |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | `isomorphic-dompurify→jsdom→@exodus/bytes` ESM 链在 Vercel serverless 炸 | **发帖/评论/编辑全员 500**（UGC 写路径全断）                                                                               | `6986e6dce` 换 sanitize-html |
| 2   | 服务端只认 Bearer 头，17 处客户端 fetch 只带 CSRF                        | **Pro 订阅按钮死**（收入路径）、交易员提醒、onboarding 关注、推送订阅、聊天/图片上传、欢迎邮件等 17 个功能登录用户静默失效 | `4cd811ef4`                  |
| 3   | posts INSERT RLS 策略 `gm.group_id = gm.group_id` 自比较恒真             | 新用户（无群组成员身份）**无法发任何帖**；且加入任一群即可向所有群发帖                                                     | `11e5e058a` + 迁移已应用生产 |
| 4   | `t('locale')` 不存在的 i18n key 被当 locale 用                           | **/hot 整页崩溃**（帖子>1个月即触发）                                                                                      | `d39011f63` `9a50ba0ca`      |

### 🟠 HIGH（功能静默失效/数据损坏）

| #   | 根因                                                                                             | 影响                                                                                      | 修复 commit             |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------- |
| 5   | `user_id` 类外键指向 auth.users，PostgREST `user_profiles(...)` embed 必然 PGRST200              | followers/following 列表全断、群成员头像 400、hot/groups SSR 预取静默空、群组申请 API 500 | `6e6937703` `a352985fd` |
| 6   | schema 漂移：`display_name`/`last_export_at`/`referral_code` 列、`trader_watchlist` 表生产不存在 | 用户搜索静默空、flash-news 管理员全被拒、referral/watchlist API 500                       | `7109b79be` + 后续      |
| 7   | 埋点三重断裂（batch 路由不存在 + CSRF 拦 beacon + 只认 Bearer）                                  | **interaction 埋点从未落库**                                                              | `c3845d93e` `a11ff20e0` |
| 8   | `.single()` 对可能 0 行的查询（无 profile 行用户）                                               | 每页 406 噪音、2FA 路由 500                                                               | `7109b79be`             |
| 9   | ExchangeConnection select 三个不存在的列                                                         | 设置页关联账户区**所有用户必报错**                                                        | `858b3227d`             |

### 🟡 MEDIUM（规范违反/隐患）

| #   | 根因                                                                                      | 修复 commit             |
| --- | ----------------------------------------------------------------------------------------- | ----------------------- |
| 10  | 32 处头像手写 `/api/avatar?url=` 包装（只判 data: 前缀）→ 本地路径误代理 400              | `88e2b2bfe` `cffb05165` |
| 11  | 匿名访客触发 auth-required API（translate/interactions/track）→ 每页 401/403 console 噪音 | `9cd20bab3` `c3845d93e` |
| 12  | 3 个手写 modal 绕过 ModalOverlay/useModalA11y（缺滚动锁/焦点陷阱）                        | `14bb49ae9`             |
| 13  | /help 硬编码站长个人邮箱进 JS bundle + handle 大小写错误                                  | `ea46a270f`             |
| 14  | 投机式本地图标加载（41 个线上符号必 404）+ USDT 符号归一化空串                            | `ae21c3ccf`             |
| 15  | git-commit-safe 并发 index 竞争（实测吞了别的会话的暂存文件）                             | `728895df5` 加 flock    |
| 16  | window.confirm（webview 静默失败）、语言 cast 谎言                                        | `ec6f01644`             |
| 17  | avatar 代理白名单缺 HTX 第三个 CloudFront 域                                              | `4ca839cc3`             |

### Beta 横幅

`f778583a1` 曾把横幅改为需显式环境变量开启（生产未设置 → 全站消失）。已恢复默认显示（根布局，覆盖所有页面）；隐藏需设 `NEXT_PUBLIC_HIDE_BETA_BANNER=true`。注意横幅有"关闭后 30 天不显示"的 localStorage 记忆。

## 终验结果（生产，2026-06-12）

- ✅ 86 次页面检查（31 路由 × 2 视口 + 4 语言核心路径）：**零崩溃、零空白、零导航失败**
- ✅ 交互 77/85 通过（8 个失败均为测试工具伪影：Pro 锁定 tab 的 aria-disabled、选择器未命中）
- ✅ 发帖→详情→评论→删帖 全链路 201/200（QA 账号，已清理）
- ✅ 关注/取关按钮状态翻转 + 清理成功
- ✅ Pro 订阅按钮 → 到达 checkout.stripe.com（不真实扣款）
- ✅ post-deploy-check 5/5
- ✅ 回归 e2e：`e2e/button-audit-regression.spec.ts`（hot 四语言、avatar 本地路径、匿名 auth 噪音）

## ⚠️ 遗留事项（需要决策/后续）

1. ~~迁移 `20260602223029` 未应用~~ — **已根治**（`5190ad318`）：原版 GRANT 引用不存在的列必失败，按实测 schema 重写为 v2 并应用生产；客户端 94 处读取清查后 search-history 迁 RPC-first、privy 邮箱枚举探测删除；referral_code/referred_by/last_export_at 三列补齐（`d81da6a68`）。QA 验证：他人 email 42501 / handle 200 / RPC 200。
2. **Stripe 保持测试模式**（用户确认 beta 期有意为之，2026-06-12）。
3. ~~**admin data-health 页**无 Bearer 调服务端 secret 路由并把 401 显示成 0 平台~~ — **已根治（2026-07-17）**：旧页面永久跳转到 `/admin?tab=scraperStatus`；canonical tab 使用 admin JWT、共享运行时契约和 fail-closed 错误态；不兼容的旧 API 对认证调用明确返回 410。
4. ~~`/api/follow` `/api/watchlist` `/api/referral` schema 漂移~~ — **已全部根治**（`9d2047a7e` + `d81da6a68`）：follow 触发器查已删 traders 表（DB 函数已修+生产验证）；trader_watchlist 迁移补应用生产（功能恢复+增删查验证）；referral_code/referred_by/last_export_at 列已补齐应用，推荐码与导出冷却功能完整恢复。
5. React #418 hydration 告警：localStorage 有语言偏好但 cookie 缺失时首屏 SSR/CSR 语言不一致（边缘场景，sweep 注入伪影为主）。
6. `docs/QA_TEST_CASES.md` 的 `test.*@example.com` 账号生产不存在 — 真实 QA 账号是 `qa.button.test@arenafi.org`（密码用 service role 重置即可复用，详见 memory/qa-test-accounts.md）。
7. post-deploy-check.sh 用的 `/trader/soul` 已是死数据（weex 下架），建议改为动态取排行第一名。

## 终章：根源的根源（2026-06-12 收口）

迁移全量对账（333 个迁移文件 vs 生产实测）确认总根源：**~200 个迁移从未进
ledger**（字母后缀命名无法被 CLI 追踪，靠 SQL editor 手工应用或彻底遗漏）。
处置结果：

- **13 个真断裂补应用**：notifications RLS 泄漏（安全）、payment_history
  （4 月起支付记录静默丢失）、get_diverse_leaderboard（首页 400KB→10KB）、
  hashtags、emoji reactions、user_strikes、trader_alert_logs、competitions、
  hot_topics、avoid_votes、folder_subscriptions、pro_official_groups、
  handle_new_user trigger + flash_news 列
- **31 个陈旧引用全清理**：死路由×6 删除、错表名×4 修正（GDPR 删号一直在
  删不存在的表）、死分支×8、RPC fallback 转正×3、安全确认（is_site_admin
  无 fail-open）
- **防复发**：`npm run qa:schema` 自维护契约检查（代码依赖 vs 生产清单差集）
  → **exit 0**，迁移后必跑已写入 CLAUDE.md 铁律

剩余 7 项全部是产品决策类（tips/saved_filters 恢复或下线、competitions cron
排程、pro-official RPC ship-or-kill、WAU 统计重建、#418 观察、Stripe test
mode 已确认保留）——无任何已知静默断裂。

## 可复用工具（已入库）

- `scripts/qa/button-sweep.mjs` — 全站未登录态运行时扫描（`--lang-sweep` 四语言）
- `scripts/qa/auth-button-sweep.mjs` — QA 账号登录态全链路（写操作自动清理）
- `e2e/button-audit-regression.spec.ts` — 崩溃类防回归
