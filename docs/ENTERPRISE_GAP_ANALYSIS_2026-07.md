# Arena：vibe coding → 企业级工程 差距分析（2026-07-02）

> 三路并行仓库审计（测试/CI 门禁、安全/可靠性/可观测性、架构/代码健康/流程）
>
> - 外部行业标准调研的综合结论。作为分阶段提升路线图的依据。
>   执行台账：本文末尾「Phase 1 落地记录」持续更新。

## TL;DR

**Arena 的安全基线与工程"意识"远超典型 vibe coding 项目，真正的企业级差距不在
代码，而在强制力与制度**：质量门禁全在客户端可绕过、部署与 CI 解耦、基础设施
单点故障、运维知识只在一人脑中。行业调研同样指向：vibe coding 项目的核心差距
是治理（governance），不是代码生成质量本身。

分级速览（A=接近企业级，D=差距显著）：

| 维度                                       | 分级   | 一句话                                                             |
| ------------------------------------------ | ------ | ------------------------------------------------------------------ |
| 安全基线（加密/鉴权原语/限流/支付幂等）    | **A-** | zod env 校验、timing-safe 比较、AES-256-GCM、Stripe 原子幂等均达标 |
| 可观测性工具（Sentry/结构化日志/健康端点） | **B+** | 工具齐，缺 SLO/metrics/分级告警制度                                |
| 文档密度（ADR/RUNBOOK/ONBOARDING）         | **B+** | 远超同类，但知识仍高度个人化                                       |
| 测试广度（E2E 矩阵/API 测试）              | **B**  | 46 E2E spec × 4 设备、42 API route 测试                            |
| 测试深度（覆盖率/组件层）                  | **D+** | coverage 门槛 lines 14%，组件测试 8/2016 文件                      |
| CI/CD 强制力                               | **D**  | CI 完整但不门禁部署；100% 直推 main；门禁全在本地 hooks            |
| 基础设施冗余                               | **D+** | Mac Mini + 2 台 VPS 单点，failover 半人工                          |
| 发布纪律                                   | **D**  | version 永远 0.1.0，7800+ commit 无 CHANGELOG/semver tag           |

## 一、差距分析（按风险排序）

### 1. 部署不受 CI 保护（最高风险）

- **事实**：Vercel Git 集成 push main 即部署，不等 GitHub Actions 结果；
  `ci.yml` 注释自认"2026-06 自查:CI 早已多处全红"仍在持续部署。
  全历史 7,800+ commit 仅 2 个 PR，最近 50 个 commit 0 merge、100% 直推 main。
- **对照**：企业级 = required status checks 门禁 merge/deploy + 自动回滚。
- **风险实例**：2026-04-22 事件——629 个 commit 无人验证，交易员详情页 500
  数天无人发现（见 docs/postmortems/）。
- **对策**（Phase 1）：CI 修真绿 → Vercel `ignoreCommand` 查 CI conclusion →
  smoke 失败自动 promote 回滚。

### 2. 基础设施单点故障

- **事实**：Mac Mini 承载 OpenClaw 自治运维 + 本地 cron + R2 备份编排 + phemex
  独占抓取；SG VPS（scraper/proxy/Meilisearch，2GB RAM、磁盘 95%）、JP VPS。
  failover 是半自动（Telegram 告警 + 手工 `pm2 restart` / redis SET failover）。
  GitHub Actions 冗余只覆盖健康告警，不覆盖抓取/备份。
- **对策**：Phase 1 先做备份编排冗余（GH Actions 每日 pg_dump→R2 + 备份新鲜度
  哨兵）；抓取/运维职责迁移到托管基础设施属 Phase 2（需外部资源）。

### 3. 无默认拒绝的统一鉴权层

- **事实**：无根级 `middleware.ts`，313 个 API route 靠各自自觉调用 wrapper
  （`withCron`/`withAdminAuth`/`verifyAuth`——wrapper 本身质量高）。143/313
  引用 auth 原语，差值多为合法公开读，但**漏加鉴权不会被框架拦住**（fail-open）。
- **对策**（Phase 1）：CI 层兜底——`api-auth-coverage-check` 强制每个 route
  要么引用 auth 原语、要么在显式公开白名单；比运行时 middleware 重构风险低。

### 4. 巴士系数 ≈ 1

- **事实**：95.4% commit 单一身份；CLAUDE.md 621 行含 17 处"血泪教训"是关键
  运维知识唯一载体；VPS 部署文档 24 处手工 ssh 步骤；DECISIONS.md 已 5 周未更新。
- **对照**：企业级 = 知识制度化、任何角色可按文档接手。
- **对策**：Phase 1 建 postmortem 制度固化事故学习；Phase 2 知识文档化冲刺
  （CLAUDE.md 教训升格为 docs/ 制度文档）+ PR 流程。

### 5. 数据库迁移漂移 ✅ 已根治（2026-07-02）

- **事实**：377 个迁移文件中 317 个与生产 ledger 失配（文件名↔version 对不上，
  字母后缀命名无法进 ledger），曾造成发帖/点赞/订阅/支付记录长期静默 500。
- **已根治**：完整只读三方审计（`docs/MIGRATION_DRIFT_AUDIT_2026-07-02.md`）证明
  运行系统零风险（qa:schema 绿=代码依赖全在生产），漂移是记账错位而非 schema
  缺失。经 Supabase MCP 单一通道补记 317 版本到 ledger（186→504，纯记账零 DDL），
  全量验证 377 个仓库版本**全部在 ledger**（`repo_versions_missing_from_ledger=0`），
  `supabase db push` 已变 no-op，footgun 消除。可逆（created_by 标记）。
- **后续（可选，非紧急）**：377 文件杂乱可择日 squash 到单一 baseline 清理
  （需 shadow-DB 验证），本次不做——先安全消危，不为减文件数赌未验证 baseline。

### 6. 测试深度不足

- **事实**：173 个单测 + 46 个 E2E spec（4 设备矩阵）+ 42 个 API route 测试——
  广度尚可；但 coverage 门槛 lines 14%/functions 10%（棘轮自认），组件测试仅
  8/2016 个源文件；`.tsc-legacy-errors.txt` 166 条类型错误被 pre-push 静默放行；
  `as any` 36 处仅 warn、eslint-disable 283 处。
- **对照**：企业级 = 关键路径 60-80% 覆盖、类型零豁免。
- **对策**（Phase 1）：legacy 类型错误烧减 + "只减不增"断言；核心组件补测试后
  上调 coverage 棘轮。深度补齐是长期棘轮工程，不是一次性任务。

### 7. 可观测性缺制度层

- **事实**：Sentry（client/server/edge + noise 过滤）、结构化日志占绝对主导
  （app/ 仅 5 处 console.log）、6 个 health 端点、30min 轮询 + Telegram 告警——
  工具层良好。缺：SLO/错误预算、时序 metrics dashboard、分级告警、postmortem
  制度（docs/ 无一篇事故复盘）。
- **对策**（Phase 1）：docs/SLO.md 定义 3-5 条 SLO + health-monitor 按阈值分级
  告警 + postmortem 模板与回填。OTel/Grafana 标准栈列 Phase 2。

### 8. 无发布纪律

- **事实**：version 永远 0.1.0、无 CHANGELOG、git tag 仅一个 `last-known-good`
  回滚锚点。无法回答"哪个版本引入了什么"。
- **对策**：回滚锚点用 Vercel 部署历史（每个 READY 部署带 `gateSha` meta +
  smoke 通过才成为最新，promote API 直接选上一个 READY）——比 git tag 可靠且
  不受仓库 PR-only ruleset 阻挡；semver+CHANGELOG（release-please）列 Phase 2。

### 9. 重复与数据层不统一（comprehension debt 的典型症状）

- **事实**：3 套货币格式化（`formatMoney`/`formatUSD`/`formatCurrency`）、
  2 套日期格式化；React Query 29 文件 vs 手写 fetch 109 文件；10 个 >1,000 行
  巨型页面组件（最大 channels page 1,465、RankingTable 1,458）。
- **⚠️ 审计误报更正（2026-07-02）**：原报告称"2 套 i18n 系统"是**误报**。
  `lib/i18n.ts`（客户端运行时 t()/loadTranslations）与 `lib/i18n/*.ts`（翻译数据 +
  服务端 helper）是**刻意的运行时/数据分离 + 代码分割**（避免 180KB en.ts 静态
  打包，en-core/zh-core 供 SSR、完整字典水合时懒加载）——正确架构，**不该合并**。
  已移除其中 2 个确认死掉的 `@deprecated load*Translations` 导出。
  → [[feedback-verify-before-fix]] 的又一例证：审计发现不是事实，核实后再动。
- **对策**：货币格式化已建 import 棘轮（Batch F2，禁新增引用）。真实剩余 =
  巨型组件拆分（10）+ 手写 fetch→React Query（109）——**高回归风险、需跑应用
  点击验证**，组件测试近零，不能在无验证批量 pass 里盲改；列 Phase 1.5 逐文件
  带验证增量推进（见路线图）。

### 10. 仓库卫生

- **事实**（2026-07-02 已清理）：`undefined/` 目录（browse 会话变量未定义产物
  3.1M）、721KB `.lighthouse-report.json`、docs/ lighthouse json ——已移除并
  gitignore；12 个无引用一次性脚本已归档 `scripts/archive/`。
  未做：docs/ 带日期报告归档（7 个中 5 个是在用台账，收益为负，暂缓）。

## 二、已达或接近企业级的部分（审计确认，避免自我贬低）

- **安全**：zod fail-fast env 校验（CRON_SECRET 强制 ≥32 字符）；Stripe webhook
  签名校验 + 原子幂等（unique 约束 23505）；timing-safe 服务鉴权；交易所凭证
  AES-256-GCM 加密；236/313 route 限流且区分 fail-close/open；HSTS/CSP/XFO 安全
  headers；无硬编码密钥（grep 全量验证）。
- **可靠性工具**：circuit breaker（cockatiel）+ 重试 + 分布式锁；R2 异地备份
  （日备 14 天保留）；高质量 RUNBOOK；BullMQ 3x 重试。
- **工程治理雏形**：三套棘轮（coverage/cast 禁令/design token）"只能升不能降"；
  pre-push 7+ 条根因 pattern guard（每条对应一次真实事故）；conventional
  commits 100% + commit-msg hook；schema 契约检查（qa:schema）+ 每日金丝雀哨兵；
  dependabot + npm audit 阻断 + SECURITY.md 书面风险评估。
- **合规基础**：privacy/terms/disclaimer/dmca 页面；账号软删除 30 天宽限 + 数据
  导出（GDPR 可携带权）；admin 操作审计日志。
- **文档**：ADR 格式 DECISIONS.md、ARCHITECTURE.md、ONBOARDING、32KB README、
  4 语言 i18n 100% parity。

## 三、行业对照（外部调研）

- 92% 开发者日常使用 AI 编码工具但仅 29% 信任其产出；采纳速度远超治理建设速度，
  伴随 41% bug 率上升——差距在流程不在工具（[Keyhole Software 2026 趋势][kh]、
  [RTS Labs 企业治理指南][rts]）。
- 45% 的 AI 生成代码含 OWASP Top 10 类漏洞；金融平台被明确列为"最不宜纯 vibe
  coding"领域——Arena 作为涉资金数据的平台需要更严的安全门禁（[Builder.io
  局限分析][builder]）。
- SRE 建设的推荐顺序：先收敛告警 → SLO → 事故纪律（runbook/postmortem）→
  韧性 → 成本（[OneUptime SRE checklist][ou]、[Cortex 生产就绪清单][cortex]）。
  Arena 已有告警与 runbook，下一步正是 SLO + postmortem。
- "Comprehension debt"（Addy Osmani，2026）：没人深度理解的已上线代码是 AI
  项目最大长期负债；对策 = 测试基线 + ADR + 对 AI 代码更严的质量门禁
  （[Hamade 成本分析][hamade]、[Baytech TCO 分析][baytech]）。

[kh]: https://keyholesoftware.com/vibe-coding-trends-2026/
[rts]: https://rtslabs.com/enterprise-vibe-coding/
[builder]: https://www.builder.io/m/explainers/vibe-coding-limitations
[ou]: https://oneuptime.com/blog/post/2025-09-10-sre-checklist/view
[cortex]: https://www.cortex.io/post/how-to-create-a-great-production-readiness-checklist
[hamade]: https://medium.com/@justhamade/true-cost-of-ai-generated-code-f4362391790c
[baytech]: https://www.baytechconsulting.com/blog/ai-technical-debt-how-vibe-coding-increases-tco-and-how-to-fix-it

## 四、路线图

### Phase 1 — 单人+AI 更稳（2026-07 起，本轮连续落地）

| #   | 项                                                                       | 状态                 |
| --- | ------------------------------------------------------------------------ | -------------------- |
| A   | 仓库卫生：undefined//lighthouse 产物清理 + gitignore + 脚本归档          | ✅ 2026-07-02        |
| B   | 本差距报告                                                               | ✅ 2026-07-02        |
| C1  | post-deploy smoke 失败自动回滚（代码已在库，激活待 VERCEL_TOKEN secret） | ⏳ 待用户配 secret   |
| C2  | CI 修真绿（npm audit 清零 + per-SHA concurrency）→ 门禁部署待 token      | ✅ CI 真绿 / ⏳ 门禁 |
| D   | api-auth-coverage-check：route 级默认拒绝 CI 兜底 + 321 route 全量判定   | ✅ 2026-07-02        |
| E1  | postmortem 制度 + 回填 4 起（含新发现的备份静默失败 SEV2）               | ✅ 2026-07-02        |
| E2  | 备份新鲜度哨兵（首跑抓出 SEV2 并已止血）；GH 冗余备份待 secrets          | ✅ 哨兵 / ⏳ 冗余    |
| E3  | docs/SLO.md 首版 5 条                                                    | ✅ 2026-07-02        |
| F1  | .tsc-legacy-errors.txt 全量清零（166 条全是死条目，超预期完成）          | ✅ 2026-07-02        |
| F2  | 货币格式化 import 棘轮（error 级禁新增，存量 13 文件迁一删一）           | ✅ 2026-07-02        |
| F3  | coverage 棘轮上调 14→20（实测 2300 测试全绿；组件补测列长期棘轮）        | ✅ 2026-07-02        |

### Phase 1.5 — 独立专项（单独会话/窗口）

- 迁移漂移历史对账 / 基线压缩（需生产窗口 + schema 单一通道纪律）
- i18n 两套系统合并；巨型组件拆分（channels/RankingTable/settings hooks）
- React Query 统一数据获取层（108 个手写 fetch 迁移）

### Phase 2 — 团队化 / 尽调准备（有队友或融资信号时启动）

- PR 流程 + CODEOWNERS + branch protection 强制 review
- semver + CHANGELOG（release-please 自动化）
- 独立 staging 环境
- OTel/Grafana 标准观测栈（替代自建 PipelineLogger 指标）
- Mac Mini/VPS 职责迁移到托管基础设施（$，外部资源）
- 知识文档化冲刺：CLAUDE.md 血泪教训升格为 docs/ 制度文档
- SOC 2 风格控制映射（尽调材料）

## Phase 1 落地记录

- 2026-07-02：Batch A 完成（gitignore 加固 cbd8c60ca、脚本归档 e932f0946）。
  docs/ 日期报告归档暂缓（5/7 是在用台账）。
- 2026-07-02：**CI 修真绿达成**——两个根因：① npm audit 16 high 阻断
  （audit fix + viem 嵌套 override 压 ws，b879c2fe9）；② per-ref
  cancel-in-progress 让高频直推互相取消、CI 忙时永远跑不完（改 per-SHA 分组
  - E2E job 级 per-ref cancel，9abb80f5c）。改后四个门禁作业
    （pre-checks/lint-typecheck/unit/build）全绿。
- 2026-07-02：Batch D 完成——api-auth-coverage-check（321 route 全量判定，
  64 公开白名单登记理由；唯一真问题 onchain-enrich 公开 POST 无限流已补
  sensitive 15/min fail-close，2d8648942）；接入 ci.yml 阻断 + pre-push 有界。
- 2026-07-02：Batch E 完成——postmortem 制度 + 回填 3 起（df5dbe086）；
  SLO 首版 5 条 + 备份新鲜度哨兵（42f776a05）。**哨兵首跑即抓出 SEV2：
  日备静默失败 3 周**（crontab 调度丢失 + GH 兜底告警 secrets 未配双死），
  已补跑备份恢复 RPO，复盘 PM-20260702-backup-silent-failure.md。
- 2026-07-02：Batch F——tsc 豁免名单 166 条全量清零（实测 0 error，全是
  死条目，a0b53152b）；货币格式化 import 棘轮（303b59e5b）。
- 2026-07-02（用户授权后）：**三项待办全部落地**——
  1. GH secrets 配齐（TELEGRAM×2/CRON_SECRET/VERCEL_TOKEN/ORG_ID/PROJECT_ID），
     全部 GH 告警与自动回滚复活。注意 VERCEL_TOKEN 用的是本机 CLI 登录 token
     （全账户权限）——建议后续在 Vercel Dashboard 换发 scoped token 替换。
  2. crontab 恢复（日备 03:30 + 备份哨兵 09:00）。
  3. **CI 门禁部署上线（d16fc157a）**：push main 不再直通生产；
     4 门禁作业全绿 → deploy-gate.yml CLI 部署 → 内嵌 smoke → 失败自动
     promote 回滚。逃生口 `[deploy-force]`；一行 revert vercel.json
     ignoreCommand 可回旧行为。附带发现并修复：promote API 端点 v6 是 404，
     旧 post-deploy-smoke 的回滚代码从未可能成功（改 v10 并实测 409 no-op 验证）。
