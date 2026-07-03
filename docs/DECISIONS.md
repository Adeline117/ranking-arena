# 架构决策记录（ADR）

> 把散在 CLAUDE.md 的"铁律/血泪教训"抽成可检索的决策记录，降低巴士系数——
> 每条决策的**为什么**不再只存在于一人脑中。每条 = 背景（什么事故/需求催生）/
> 决策 / 后果。新决策追加到末尾，不改历史条目（改则新增一条 supersede）。
> 2026-07-02 首版（Phase 2 知识文档化）。

---

## ADR-001：计数器用原子 RPC，不用触发器

- **背景**：trigger-based `SET count = count + 1` 在并发下丢更新（社交计数长期偏差）。
- **决策**：计数一律用原子 RPC（`increment_*_count`/`decrement_*_count`，迁移 00021），
  在 API handler 显式调用。禁触发器改计数。
- **后果**：计数并发安全；代价是每处改计数要记得调 RPC（pre-push 无法完全强制，靠 review）。

## ADR-002：一人一资源加唯一约束，23505 优雅处理

- **背景**：check-then-act 竞态导致重复 default bookmark folder 等。
- **决策**：one-per-user 资源加 UNIQUE / 部分唯一索引；捕获 `23505` 后**重查**而非报错。
  check-then-act 用 `pg_advisory_xact_lock` 或 `SELECT ... FOR UPDATE` 防 TOCTOU。
- **后果**：并发下无重复；错误路径要写 re-query 分支。

## ADR-003：乐观更新用 delta 回滚，不用快照捕获

- **背景**：快照捕获在父组件 fetch 中途 re-render 时变陈旧，回滚回错误值。
- **决策**：所有乐观更新用 delta 反向（`likeDelta = wasLiked ? -1 : 1`），出错时反向 delta，
  不捕获 `prevPost` 快照。
- **后果**：re-render 期间回滚正确；心智模型是"记住变化量"而非"记住旧值"。

## ADR-004：schema 变更走单一通道（防迁移漂移）

- **背景（根源教训 2026-06）**：多会话各自手工 SQL-editor/MCP 用**任意名**应用迁移，
  字母后缀（`20260319h_*`）无法进 ledger → 仓库↔ledger 失配、~200 迁移漂移 →
  发帖/点赞/订阅/支付**长期静默 500**。根因是 AI 生成速度远超验证速度。
- **决策**：(1) 写任何 `.from('x')`/`.rpc('y')`/`select('col')` 前先确认生产存在
  （MCP 或 REST `?select=col&limit=0`，42703=列不存在），绝不凭训练先验假设 schema；
  (2) 迁移只经 `scripts/new-migration.sh`（纯时间戳）创建、单一会话应用、`qa:schema` 核对；
  (3) 禁 `as any` 绕过生成类型；(4) catch/safeQuery 的 DB 错误必须 log 不许静默吞。
- **后果**：漂移可检测（qa:schema CI 门禁 + 每日金丝雀）。2026-07-02 已对账
  （ledger 补记 317，push no-op，`docs/MIGRATION_DRIFT_AUDIT_2026-07-02.md`）。

## ADR-005：多会话编排纪律（共享工作树的并发安全）

- **背景**：最多 7 个 claude 会话 + cron + worker 共用一个仓库目录。血泪：
  共享工作树改 database.types/eslint/tsconfig 当场污染所有会话的 tsc/lint；
  pre-push 塞无界操作拖垮所有会话推送；并发 fork 顶爆 macOS syspolicyd。
- **决策**：schema 单一通道串行化；pre-push 检查必须快/有界(timeout)/fail-open，
  重活交 CI；高风险核心文件先隔离 worktree 验证再落共享树；并发上限 2-4 非 7；
  worker 部署走单一通道（CI 产物流水线，绝不多会话手工 `deploy-ingest-sg.sh` 并发）。
- **后果**：并发协调成本可控；交互会话强烈建议独立 worktree
  （`scripts/new-session-worktree.sh`）。

## ADR-006：CASCADE 删除靠 FK 约束，不手工删子表

- **背景**：手工先删子表后删父表的顺序错误 + 漏删导致孤儿行。
- **决策**：父表 FK 一律 `ON DELETE CASCADE`；绝不在应用层手工删子行再删父行。
- **后果**：删除一致；schema 设计时必须想清 FK 级联。

## ADR-007：模态框/付费墙/通知走强制共享基建

- **背景**：手写 backdrop/scroll-lock/escape、手写 `isPro ? ...` upsell、
  裸 `notifications.insert` 各自出过 a11y/泄露/阻塞 bug。
- **决策**：模态一律 `ModalOverlay`/`useModalA11y`；付费墙一律 `ProGate`/`ProUpsellModal`；
  通知一律 `sendNotification()`（fire-and-forget + 去重 + 错误隔离）。
  裸 `.from('notifications').insert` 被 pre-push 硬拦。
- **后果**：a11y/scroll/去重统一；pre-push grep 是硬门（含多行 perl 绕过检测）。

## ADR-008：Stripe 幂等 + DB 锁做支付安全

- **背景**：HTTP 无状态，客户端禁用按钮不可靠；lifetime spots 超卖风险。
- **决策**：每个创建计费资源的 Stripe 调用必带 `idempotencyKey`（user+resource+分钟窗）；
  稀缺检查用 `pg_advisory_xact_lock`；webhook 签名校验 + `stripe_events` 唯一约束幂等。
- **后果**：24h 内去重、无超卖；每个新支付路径要记得加幂等 key。

## ADR-009：Supabase Realtime 必须 mountedRef 守卫

- **背景**：组件在 async subscribe 期间 unmount 导致 WebSocket 泄露。
- **决策**：所有 realtime 订阅用 `mountedRef` 守卫（connect 置 true / subscribe 回调查 /
  disconnect 置 false）。
- **后果**：无 WS 泄露；每个订阅 hook 要写守卫样板。

## ADR-010：每修即 commit+push + 部署后必验证

- **背景（2026-04-22 事故）**：629 个 commit 无人验证，交易员详情页 500 持续数天。
- **决策**：一问题一 commit 立即 push（`scripts/git-commit-safe.sh`）；每次 push 后
  跑 `scripts/post-deploy-check.sh`（5 核心 URL 非 500）。
- **后果**：小步可回滚；2026-07-02 进一步上 CI 门禁部署 + 自动回滚（见 ADR-011）。

## ADR-011：CI 门禁部署 + ancestry 判定（2026-07-02）

- **背景**：Vercel push-main 即部署、不等 CI，CI 常年全红仍上线；旧回滚 API 端点 404
  从未成功过。
- **决策**：`vercel.json` ignoreCommand 跳过 main 生产 git 构建；CI 四门禁作业绿后
  `deploy-gate.yml` 用 Vercel CLI 部署，内嵌 smoke + 失败自动 promote 回滚（v10 端点）；
  部署判定用 `git merge-base --is-ancestor` 部署"比线上新"的 SHA（防回退 + 防爆发期饥饿）；
  `[deploy-force]` 为逃生口。详见 `docs/RUNBOOK.md` 部署管线。
- **后果**：CI 红则扣留部署；回滚锚点 = Vercel 部署历史（`--meta gateSha`）。

## ADR-012：API 鉴权默认拒绝兜底 + 迁移 ledger 对账（2026-07-02）

- **背景**：无根级 middleware，313+ route 靠自觉调 auth wrapper = fail-open；
  迁移漂移使 `db push` 危险。
- **决策**：`qa:api-auth` CI 门禁强制每 route 有 auth 原语或登记公开白名单；
  迁移 ledger 补记 317 版本使 `db push` no-op（选记账对账而非激进 squash——
  不为减文件数赌未经 shadow-DB 验证的 baseline）。
- **后果**：漏加鉴权被 CI 拦；未来 squash 清理留给有 shadow-DB 的窗口。

---

> 相关：铁律摘要见 `CLAUDE.md`；事故复盘见 `docs/postmortems/`；
> 发布流程见 `docs/RELEASE.md`；架构数据流见 `docs/ARCHITECTURE.md`。
