# QA 常态化固化 + 登录态写流程沙盒 — 实施计划（2026-07-02）

> 背景：2026-07-02 两波深度点击修复（共 ~100 commit）后，批评员判定核心语义面已扫透、
> 不宜再全量手工重扫。剩两件长期工程：**A. 把语义级检查固化成机判 + 每日 cron**（一次性
> 投入、长期省力），**B. 登录态写流程端到端沙盒验证**（唯一没跑通的真面）。本文是两者的
> 落地计划，所有文件行号经三路 recon 核实（2026-07-02）。

---

## 现状校正（写计划前必须知道的三个真相）

1. **`exhaustive-sweep.mjs` 已有大量机判**（可视性/denylist/write-action/console/pageerror/
   4xx-5xx 捕获/URL 变化 diff），但**恰好缺三条**：死按钮检测（无 DOM diff）、raw i18n key
   泄漏通用规则、颜色对比度。见 §A1。
2. **crontab 文档 ≠ 现实**：README 记的 health-monitor/schema-canary/ux-patrol 等 sentinel
   **实际没装进 Mac Mini crontab**——真实 `crontab -l` 只有 2 条备份任务（还有注释记录备份曾
   静默丢 3 周）。任何"挂 cron"步骤必须**亲自 `crontab -e` 确认安装**，不能假设基础设施在跑。
3. **只有一个 QA 账号**（`qa.button.test@arenafi.org`，`QA_USER_ID=1c533890-...`）。真正的
   用户对用户流程（A 关注 B、A 评论 B 的帖且 B 收到通知）**做不了**——这是 B 计划的头号阻塞。

---

# 计划 A：常态化固化（语义机判 + 每日四语言 cron）

**目标**：把两波手工审计用的语义规则变成脚本机判，每日自动跑四语言，失败 Telegram 告警，
人工只审回归 diff，不再手工全站重扫。

**投入产出**：一次性 ~1.5 天 CC 工时；之后每天自动覆盖，人工每天 ~5 分钟看告警。

## A1. 三条缺失机判规则（核心工作，改 `scripts/qa/exhaustive-sweep.mjs`）

| 规则                     | 现状                                                                    | 实现                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **死按钮**（点击无效果） | 只有 URL diff + 点击期错误捕获，无 DOM diff → 无效果按钮记 `ok:clicked` | 在 click 分支（~L441）加**点击前后快照**：`{url, DOM 内容 hash, 网络请求计数, 打开的 overlay/dialog 数, DOM 节点数}`；点击后 2s 全相等 → 新状态 `dead:no-effect` |
| **raw i18n key 泄漏**    | 仅 `serving-profiles-e2e.mjs:30` 一个窄正则（10 个前缀）                | 提取通用检测器：扫 body 文本匹配 i18n key 形态（camelCase 无空格、`t('...')` 残留、`[object Object]`、`undefined`），四语言都跑；命中 → `i18n-leak:<key>`        |
| **颜色对比度**           | 全仓库零实现                                                            | 注入 axe-core（`@axe-core/playwright`，仅 color-contrast 规则）或自算 computed-style 相对亮度；<4.5:1（大字 <3:1）→ `a11y:contrast`                              |

**配套小改**（同文件）：

- 从 `button-sweep.mjs:154` 移植 `checkPageHealth`（error-boundary/空白/404 文本）——exhaustive 目前不做
  body 健康检查。
- 4xx 目前捕获但不 gating（`exhaustive-sweep.mjs:802` 只在 5xx+pageerror 退出 1）；对用户主动点击后
  的**非白名单 4xx** 加 gating。
- 给 `exhaustive-sweep.mjs` 加 `--lang=<code>` 参数（复用 `button-sweep.mjs:211-222` 的 locale
  预置：browser locale + `localStorage.language` + `language` cookie）——目前它无语言维度。

## A2. 告警 wrapper（新文件 `scripts/openclaw/lang-sweep-sentinel.mjs`）

- **模板**：整体照抄 `scripts/openclaw/backup-freshness-check.mjs`（最干净的 daily sentinel）——
  `dotenv` 载 `.env.local`、inline `sendTelegram`、exit `0/1/2` 契约、顶层 `.catch` 告警。
- **Telegram chat id**：用 `TELEGRAM_ALERT_CHAT_ID || TELEGRAM_CHAT_ID`（recon 发现两个变量名混用，
  robust 写法带 fallback）。
- **逻辑**：spawn `exhaustive-sweep` 四语言（或先用现成 `button-sweep.mjs --lang-sweep`，但它总
  exit 0、只写 `/tmp/arena-button-sweep.json`、无告警——wrapper 解析该 JSON 数 `problems`）→
  有新 `fail:/dead:/i18n-leak:/a11y:contrast` → Telegram + exit 1。
- **回归 diff**：对比上次 ledger，只告警**新增**问题（老问题已知）。存 state 到
  `scripts/openclaw/.lang-sweep-state.json`（照 `.health-monitor-state.json` 模式）。
- **去重/退避**：daily 单次，跳过 dedup 即可；若将来改高频，复用 `health-monitor.mjs:64-91` 的
  2^streak 退避（2h→24h 封顶）。

## A3. 挂 cron（**必须亲自 `crontab -e` 确认**）

```cron
# 错峰 6AM 避开 syspolicyd fork 风暴；绝对 node 路径（cron 无 PATH）；日志重定向
0 6 * * * cd /Users/adelinewen/ranking-arena && /opt/homebrew/bin/node scripts/openclaw/lang-sweep-sentinel.mjs >> logs/lang-sweep.log 2>&1
```

- **playwright 挂 cron 是本仓库新领域**（现零 playwright cron）。坑：
  - **syspolicyd fork 风暴**（Mac Mini 是生产 worker）——错峰跑、绝不与其他 spawn 重的 cron 并发。
  - **内存**——每路由 `browser.newContext()` 用完即 close（button-sweep 已这么做）。
  - **chromium 必须为 `/opt/homebrew/bin/node` 装好**。
  - **生产礼貌**——`PAGE_DELAY_MS=1000`，打的是真生产。
- 装完在 `scripts/openclaw/README.md` 更新真实 crontab 块（并顺手把文档与现实对齐——现在脱节）。
- 注意 `health-monitor.mjs:322` 会读 `crontab -l` 校验死引用并告警，新条目须指向真实文件。

## A4. 阶段划分

| 阶段 | 内容                                            | CC 工时 | 可独立交付      |
| ---- | ----------------------------------------------- | ------- | --------------- |
| A-1  | 死按钮检测（DOM diff）+ `--lang` 参数           | ~4h     | ✅ 单独就有价值 |
| A-2  | i18n key 泄漏通用检测器 + checkPageHealth 移植  | ~3h     | ✅              |
| A-3  | 颜色对比度（axe-core）                          | ~3h     | ✅              |
| A-4  | lang-sweep-sentinel wrapper + 回归 diff + state | ~3h     | 依赖 A-1~A-3    |
| A-5  | 挂 cron + 亲验安装 + README 对齐                | ~1h     | 依赖 A-4        |

**每阶段一 commit 一 push**（铁律）。A-1~A-3 可并行三个 agent（改同一文件，需串行 merge 或分函数）。

---

# 计划 B：登录态写流程沙盒小波

**目标**：真的发帖/评论/关注/收藏/取消并验证跑通，**不污染生产、不惊扰真实用户**。

**核心难点**：安全地写。三路 recon 揭示 4 个硬约束，B 计划的全部设计都围绕它们。

## B1. 头号阻塞：需要第二个 QA 账号

- 现只有一个账号，**用户对用户流程做不了**（A 关注 B、A 评论 B 帖并触发通知）。
- 且所有自我写操作（评论自己帖/赞自己帖/关注自己）在各 route 被 self-suppress
  （`/api/posts/[id]/like:68`、`comments:162`、`users/follow` 拒 `followerId===followingId`）——
  **既不发通知，也就覆盖不到通知写路径**。
- **动作**：service role 建 `QA_USER_ID_2` + email（如 `qa.button.test.b@arenafi.org`），seed 其
  `user_profiles` 行（posts 需 `author_handle`，follow 更新 `follower_count`），扩展 `qa-auth.mjs`
  铸第二 session。

## B2. 安全写的四条纪律（全部来自 recon 的真实约束）

1. **可见性**：默认帖 `visibility:'public'`（`posts.ts:541`）→ 建后删前**公开可见于 /feed**。
   → QA 帖一律用 `visibility:'followers'`（`getPosts:290` 只查 public，followers 被排除），即使
   中途崩溃也无公开残留。保留删除→GET 404 验证。
2. **通知定向**：任何对**真实** trader/post/user 的写都会给真人发通知。→ 触发通知的写**只准
   打 QA 自己的行**（QA-B 的帖/档案）。两 QA 账号互操作，通知落在受控的 QA-B 收件箱。
3. **通知清理**：现 sweep 删帖/评论/关注但**从不清 `notifications` 行**。→ 两账号互操作后，
   须删 QA-B 收件箱里生成的通知（`deleteNotification`/`clearReadNotifications`），防堆积。
4. **账号锁 + 密码重置吊销**：`qa-auth.mjs` 密码重置会吊销该账号所有 session（2026-07-01 事故根源）。
   → 跑前把 `QA_TEST_PASSWORD` 写进 env，绝不触发 reset 路径；避免与其他 sweep/cron 并发共用账号。

## B3. 要补的写操作（`auth-button-sweep.mjs` 已覆盖 vs 缺口）

**已覆盖**（每个已自清理）：trader-follow、post CRUD、like、comment、watchlist。
**缺口（本波补）**：

- 用户对用户 follow（`/api/users/follow`，不同表 `user_follows` + 不同通知路径）
- 收藏帖（`/api/posts/bookmarks/*`，`/favorites` 现仅 render check）
- 帖投票/poll（`/api/posts/[id]/vote`）、评论点赞（`comments/like`）
- 评论回复（`parent_id`→ 独立 `post_reply` 通知路径）
- 群组 join / 群内发帖（现仅 render-only）
- **持久化严谨性**：现仅 post-delete 做真 GET 复查。→ 每个写后加 GET/RPC 复读
  （follow 查 `GET /api/users/follow`、like 查 `GET /api/posts/[id]` 的 `user_reaction`、bookmark
  查 `/api/posts/bookmarks/status`），让"按钮翻转"背后有"DB 真变了"。

## B4. Pro 付费墙锁定态：出带（不在本波主线）

- `PRO_FREE_PROMO=true`（`premium.ts:53`）时**每个账号都 effectively Pro**（客户端
  `hooks.tsx:336` `effectiveIsPremium` 在全局 flag 短路，DB tier 都不看）→ ProGate **锁定分支
  在生产不可达**。
- **无 per-account 覆盖开关**。→ 测锁定态只能用 `PRO_FREE_PROMO=false` 的 **preview 部署**
  （sweep 已参数化 `BASE_URL`）。列为**非生产子波**，promo 结束后或 preview 上单独做。

## B5. 阶段划分

| 阶段 | 内容                                                                     | CC 工时 | 前置                 |
| ---- | ------------------------------------------------------------------------ | ------- | -------------------- |
| B-1  | 建第二 QA 账号 + seed profile + `qa-auth.mjs` 双 session                 | ~3h     | 无（头号阻塞，先做） |
| B-2  | 扩展 `auth-button-sweep.mjs`：用户对用户 follow + 通知落 QA-B + 通知清理 | ~4h     | B-1                  |
| B-3  | 补 bookmark/vote/comment-like/reply 写流程 + 每写 GET 复查               | ~4h     | B-1                  |
| B-4  | 群组 join / 群内发帖（若 QA-B 可建私群）                                 | ~3h     | B-1                  |
| B-5  | Pro 锁定态 preview 子波（`PRO_FREE_PROMO=false`）                        | ~2h     | preview 部署         |

**风险最高的是 B-1**（建账号/seed，动生产 auth + user_profiles，须 service role 小心）。

---

# 建议执行顺序

1. **先做计划 A 的 A-1（死按钮检测）**——单独就补上两波都没机判的最大盲区，且不碰生产写，最安全高价值。
2. **A-2/A-3 跟上**，A-4/A-5 收口成 cron——A 计划整体一次投入、长期省力，优先级高于 B。
3. **B 计划的 B-1（第二账号）** 可与 A 并行起步（不同文件、不同风险面），它是 B 的一切前置。
4. **Pro 锁定态（B-4/B-5）** 依赖 promo 结束或 preview，最后做。

> 决策点（需你拍板）：(a) A 与 B 哪个先落地，还是并行；(b) 第二 QA 账号的 email/命名；
> (c) 颜色对比度用 axe-core（引入 devDep）还是自算亮度（零依赖但需自己维护 WCAG 公式）；
> (d) cron 时间（默认错峰 6AM）。
