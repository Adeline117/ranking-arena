# Arena Skill System - Complete Integration

> **Source of Truth**: `~/.claude/skills/` (system) + `.claude/skills/` (project)
> **Last Updated**: 2026-01-21
> **Status**: Production-ready

---

## 【1】SKILL INVENTORY

### System Skills (`~/.claude/skills/`)

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **session-start-hook** | 配置 Claude Code Web 会话启动钩子 | JSON stdin (session_id, source, cwd) | 依赖安装、环境变量设置 | 异步模式有竞态条件风险；仅适用远程环境 |

---

### Project Skills (`.claude/skills/`) - Development Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **create-plan** | 规划任务（只读模式） | 用户需求描述 | Markdown计划文档（6-10个原子任务） | 不执行代码；需配合执行技能 |
| **writing-plans** | 详细实现计划 | 功能规格 | `docs/plans/YYYY-MM-DD-<name>.md` | 假设零上下文；需详细输入 |
| **executing-plans** | 分批执行计划 | 计划文件路径 | 批次执行报告 + 验证输出 | 需架构师审查；跨会话 |
| **subagent-driven-development** | 同会话子代理执行 | 实现计划 | 双阶段审查后的代码 | 需TodoWrite追踪 |
| **systematic-debugging** | 根因分析调试 | Bug描述、错误信息 | 根因分析 + 验证修复 | 铁律：先找根因再修复 |
| **error-resolver** | 错误诊断与解决 | 错误消息、堆栈跟踪 | 诊断报告 + 解决方案 | 需正确分类错误类型 |
| **verification-before-completion** | 完成前验证 | 完成声明 | 带证据的验证状态 | 禁止无证据声明完成 |
| **test-driven-development** | TDD开发流程 | 功能/修复需求 | 测试→实现→重构循环 | 必须先看到测试失败 |
| **code-reviewer** | 全面代码审查 | 代码变更、PR | 审查报告 + 自动修复建议 | 多语言支持 |
| **requesting-code-review** | 请求代码审查 | Git SHA范围 | Critical/Important/Minor问题 | 需配合子代理 |
| **receiving-code-review** | 处理审查反馈 | 审查反馈项 | 技术评估 + 实现计划 | 禁止表演式感谢 |
| **gh-fix-ci** | 修复GitHub Actions失败 | PR编号/URL | 失败日志 + 修复计划 | 仅限GitHub Actions |
| **gh-address-comments** | 处理PR评论 | 当前分支 | 编号评论 + 修复实现 | 需gh认证 |
| **finishing-a-development-branch** | 完成开发分支 | 当前开发分支 | 4选项（合并/PR/保留/丢弃） | 破坏性操作需确认 |
| **senior-frontend** | 前端组件开发 | 组件需求、性能指标 | 组件实现 + 性能报告 | React/Next.js专注 |
| **senior-fullstack** | 全栈架构开发 | 项目需求 | 脚手架 + 架构文档 | 涵盖完整技术栈 |
| **senior-backend** | 后端API开发 | 项目路径、选项 | API脚手架 + 迁移工具 | Node.js/Python/Go |
| **senior-architect** | 系统架构设计 | 项目路径 | 架构图 + 分析报告 | 决策框架 |
| **senior-devops** | DevOps自动化 | 项目路径 | CI/CD流水线 + Terraform | AWS/GCP/Azure |
| **senior-qa** | 质量保证测试 | 项目路径、目标文件 | 测试套件 + 覆盖率报告 | 多语言多框架 |
| **senior-security** | 安全审计 | 项目代码 | 威胁模型 + 审计发现 | 渗透测试自动化 |
| **api-integration-specialist** | 第三方API集成 | 集成需求 | 代码示例 + 最佳实践 | OAuth/REST/GraphQL |
| **mcp-integration** | MCP服务器集成 | 插件配置 | `.mcp.json`配置 | 多传输协议 |
| **using-superpowers** | 技能发现与强制执行 | 任何任务 | 技能调用或明确判定 | 1%规则强制 |
| **task-execution-engine** | 任务执行引擎 | 设计文档检查列表 | 完成/失败状态更新 | Markdown复选框 |
| **plugin-settings** | 插件配置管理 | 插件需求 | `.claude/plugin.local.md` | YAML前置元数据 |
| **skill-creator** | 创建新技能 | 领域专业知识 | 完整技能包(.zip) | 6步流程 |

---

### Project Skills - Sentry Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **sentry/code-review** | Sentry风格代码审查 | PR、代码变更 | 分类反馈（安全/性能/测试） | 长期影响标记 |
| **sentry/find-bugs** | Bug与漏洞查找 | Git diff、变更文件 | 优先级问题报告 | 五阶段方法论 |
| **sentry/commit** | Sentry提交规范 | 代码变更 | 格式化提交消息 | 单一变更原则 |
| **sentry/deslop** | 清理AI生成代码 | 当前分支 | 清理后分支 | 合并前使用 |
| **sentry/create-pr** | 创建PR | 分支提交 | GitHub PR | Sentry工程实践 |
| **sentry/iterate-pr** | 迭代PR直到CI通过 | 当前分支PR | 绿色CI + 解决反馈 | 退出条件处理 |

---

### Project Skills - Database Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **postgres-schema-design** | PostgreSQL表设计 | 设计需求 | SQL DDL语句 | PostgreSQL专用 |

---

### Project Skills - UI/UX Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **ui-ux-pro-max** | 设计系统生成 | 产品类型、风格关键词 | 设计指南 + 组件 | 50+风格、97配色 |

---

### Project Skills - Analytics Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **google-analytics** | GA数据分析 | GA4属性ID、凭证 | 流量洞察 + 建议 | 需服务账号 |

---

### Project Skills - Web Development Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **react-best-practices** | React性能优化 | 性能优化请求 | 40+规则的改进建议 | 8个优化类别 |

---

### Project Skills - Productivity Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **linear** | Linear项目管理 | 用户目标 | Issue更新、工作流变更 | 需Linear MCP |

---

### Project Skills - Workflow Automation Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **planning-with-files** | 持久化文件规划 | 复杂多步任务 | task_plan.md + notes.md + deliverable.md | 三文件模式 |

---

### Project Skills - Railway Category

| Skill | Arena Task | Input | Output | Risk/Limitations |
|-------|-----------|-------|--------|------------------|
| **railway/deploy** | Railway部署 | 项目配置 | 部署状态 | Railway平台专用 |
| **railway/database** | Railway数据库 | 数据库需求 | 数据库配置 | Railway平台专用 |
| **railway/service** | Railway服务 | 服务配置 | 服务状态 | Railway平台专用 |

---

## 【2】ARENA SKILL ROUTER

### 路由规则

```
任务类型 → 首选Skill → 备选Skill → 触发条件 → 失败回退
```

---

### PR Merge（不丢功能）

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 创建PR | `sentry/create-pr` | `finishing-a-development-branch` | 分支有提交待推送 | 手动gh pr create |
| PR CI失败 | `gh-fix-ci` | `sentry/iterate-pr` | CI红色状态 | 手动读取日志 |
| PR评论处理 | `gh-address-comments` | `receiving-code-review` | 有未解决评论 | 逐条手动处理 |
| 合并前清理 | `sentry/deslop` | `code-reviewer` | AI生成代码 | 手动审查清理 |
| 合并验证 | `verification-before-completion` | `sentry/iterate-pr` | 声明"已完成" | 强制重跑测试 |

---

### Supabase / RLS

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| Schema设计 | `postgres-schema-design` | `senior-backend` | 新表/字段需求 | 遵循PostgreSQL文档 |
| RLS策略审计 | `senior-security` | `sentry/find-bugs` | 权限相关变更 | 手动RLS测试 |
| 迁移文件 | `postgres-schema-design` | `senior-devops` | 数据库结构变更 | 手动迁移编写 |
| 性能优化 | `postgres-schema-design` | `senior-backend` | 慢查询报告 | EXPLAIN ANALYZE |

---

### i18n 去硬编码

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 查找硬编码 | `sentry/find-bugs` | `code-reviewer` | 代码中发现中/英文字符串 | Grep搜索 |
| 提取文案 | `task-execution-engine` | `subagent-driven-development` | i18n任务列表 | 手动逐文件处理 |
| 验证双语 | `verification-before-completion` | `senior-qa` | i18n完成声明 | 手动检查翻译文件 |

---

### 付费功能 QA

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 支付集成 | `api-integration-specialist` | `senior-security` | Stripe相关代码 | Stripe官方文档 |
| 权限测试 | `senior-qa` | `test-driven-development` | Premium/Pro功能 | 手动E2E测试 |
| 安全审计 | `senior-security` | `sentry/find-bugs` | 涉及金钱/订阅 | OWASP检查清单 |
| 回归测试 | `verification-before-completion` | `senior-qa` | 付费功能变更 | 全量E2E |

---

### 聊天 / 群组 / 私聊

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 实时功能 | `senior-fullstack` | `api-integration-specialist` | WebSocket需求 | Supabase Realtime文档 |
| 消息存储 | `postgres-schema-design` | `senior-backend` | 消息表设计 | 遵循聊天系统模式 |
| 权限控制 | `senior-security` | `postgres-schema-design` | 群组/私聊权限 | RLS策略 |
| UI组件 | `senior-frontend` | `ui-ux-pro-max` | 聊天界面 | 组件库参考 |

---

### 视频发帖

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 上传处理 | `api-integration-specialist` | `senior-backend` | 视频上传需求 | 云存储文档 |
| 播放器 | `senior-frontend` | `react-best-practices` | 视频播放组件 | Video.js/Plyr |
| 性能优化 | `react-best-practices` | `senior-frontend` | 视频加载慢 | 懒加载+CDN |
| 存储架构 | `senior-architect` | `senior-devops` | 大文件存储 | S3/R2配置 |

---

### 交易所字段对照 Binance

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| API集成 | `api-integration-specialist` | `senior-backend` | 交易所API对接 | 官方API文档 |
| 字段映射 | `postgres-schema-design` | `api-integration-specialist` | 多交易所统一 | 手动映射表 |
| 数据同步 | `senior-backend` | `senior-devops` | 定时抓取任务 | Cron配置 |
| 错误处理 | `error-resolver` | `systematic-debugging` | API调用失败 | 重试+告警 |

---

### 排行榜 / Arena Score

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 算法设计 | `senior-architect` | `writing-plans` | Score计算逻辑 | 数学模型文档 |
| 数据库优化 | `postgres-schema-design` | `senior-backend` | 排行查询慢 | 索引优化 |
| 前端展示 | `senior-frontend` | `react-best-practices` | RankingTable组件 | 虚拟滚动 |
| 实时更新 | `senior-fullstack` | `api-integration-specialist` | 排行实时刷新 | SWR+WebSocket |

---

### Debug / 可观测性

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 错误诊断 | `systematic-debugging` | `error-resolver` | 任何Bug | 5 Whys分析 |
| 日志分析 | `error-resolver` | `gh-fix-ci` | 生产错误 | Sentry Dashboard |
| 性能问题 | `react-best-practices` | `senior-frontend` | LCP/FID超标 | Lighthouse |
| 监控配置 | `senior-devops` | `senior-security` | 告警设置 | Sentry配置 |

---

### UI 去 AI 化文案

| 场景 | 首选 | 备选 | 触发条件 | 失败回退 |
|------|------|------|----------|----------|
| 文案审查 | `sentry/deslop` | `code-reviewer` | UI文案AI痕迹 | 手动审查 |
| 风格统一 | `ui-ux-pro-max` | `sentry/deslop` | 文案风格不一 | 品牌指南 |
| 去冗余 | `sentry/deslop` | `sentry/find-bugs` | 过度解释 | 简化原则 |

---

## 【3】ARENA PROJECT MASTER PROMPT

```markdown
# Arena Project Master Prompt
# 可作为 Claude Code 默认系统提示词

## 身份
你是 Ranking Arena 项目的高级工程师。该项目是加密货币交易员排行榜与社区平台。

## 工程约束（不可违反）

### 最小改动原则
- 只修改完成任务必需的代码
- 禁止"顺便优化"、"顺便重构"
- 禁止添加未被要求的功能
- 禁止添加未被要求的注释/文档

### 可回滚原则
- 每个提交必须原子化、可独立回滚
- 数据库迁移必须幂等
- 功能开关优先于大规模代码变更
- 保留向后兼容直到明确删除

### 不重构原则
- 除非任务明确要求重构，否则禁止
- 代码风格跟随现有文件，不强加新规范
- 三行重复代码优于过早抽象

## Git 约束（不可违反）

### PR管理
- 禁止关闭他人PR（除非明确授权）
- 冲突必须融合（git merge），禁止覆盖
- 每个功能必须有可达的入口点

### 提交规范
- 遵循 Conventional Commits: `<type>(<scope>): <subject>`
- 类型: feat, fix, refactor, perf, docs, test, chore
- 单一提交单一变更
- 禁止 --force push 到 main/master

### 分支规范
- 开发分支: `claude/<feature>-<session-id>`
- 禁止直接推送 main/master
- 合并前必须通过 CI

## Supabase 约束（不可违反）

### RLS 强校验
- 每个新表必须有 RLS 策略
- 策略必须最小权限原则
- 用户数据必须 auth.uid() 校验
- 禁止 SECURITY DEFINER 绕过 RLS（除非审计通过）

### 迁移幂等
- 每个迁移必须可重复执行
- 使用 IF NOT EXISTS / IF EXISTS
- 禁止 DROP TABLE（使用软删除）
- 迁移文件名: `YYYYMMDDHHMMSS_<description>.sql`

### 数据完整性
- 外键必须有级联策略
- 敏感字段必须加密
- 审计字段: created_at, updated_at, deleted_at

## i18n 约束（不可违反）

### 禁止硬编码
- UI 文案必须使用 `t('key')` 或 `<Trans>`
- 禁止直接写中文/英文字符串在 JSX 中
- 数字/日期使用 Intl API

### 全双语
- 每个 key 必须同时有 en 和 zh 翻译
- 新增 key 必须同时更新两个语言文件
- 翻译文件: `lib/i18n/locales/{en,zh}.json`

## QA 约束（不可违反）

### 禁止假成功
- 按钮点击必须有加载状态
- API 调用必须有错误处理
- 成功/失败必须有用户反馈（Toast）
- 禁止静默失败

### 禁止"点了没反应"
- 每个交互元素必须有 hover/active 状态
- 禁用状态必须有视觉反馈
- 加载状态必须有骨架屏或 Spinner

### 测试要求
- 新功能必须有单元测试
- Bug 修复必须有回归测试
- 关键流程必须有 E2E 测试

## 合规红线（绝对禁止）

### 金融合规
- 禁止提供投资建议（"应该买入"、"推荐跟单"）
- 禁止托管用户资金
- 禁止代用户执行交易

### 数据合规
- 禁止存储交易所 API Secret
- 禁止记录用户真实交易数据
- 用户数据展示必须可匿名化

### 内容合规
- 禁止虚假宣传收益率
- 禁止保证盈利
- 风险提示必须显著

## Skill-First 工作流

在开始任何任务前：
1. 检查 `.claude/skills/` 是否有适用技能
2. 按 ARENA SKILL ROUTER 选择技能
3. 明确说明使用了哪些技能
4. 如未使用某可用技能，必须说明原因

## 验收标准模板

每个任务完成时必须回答：
- [ ] 是否遵循最小改动原则？
- [ ] 是否可独立回滚？
- [ ] 是否通过 TypeScript 类型检查？
- [ ] 是否通过 ESLint？
- [ ] 是否有必要的测试？
- [ ] 是否更新了 i18n？
- [ ] 是否有用户反馈（加载/成功/失败）？
```

---

## 【4】FILL-IN PROMPT TEMPLATES

### Template 1: Bug 修复

```markdown
## 任务：Bug 修复

### Skill Router 决策
- [ ] 首选 Skill: `systematic-debugging`
- [ ] 备选 Skill: `error-resolver`
- [ ] 原因: _______________

### 输入
- **Bug 描述**: _______________
- **复现步骤**:
  1. _______________
  2. _______________
- **期望行为**: _______________
- **实际行为**: _______________
- **错误信息**: _______________

### 范围限制
- 涉及文件: _______________
- 禁止修改: _______________
- 不重构: [x] 确认

### 验收标准
- [ ] 根因已定位并记录
- [ ] 修复通过回归测试
- [ ] 无新增 TypeScript 错误
- [ ] 无新增 ESLint 警告
- [ ] 用户反馈已添加（如适用）

### 输出
- 根因分析: _______________
- 修复方案: _______________
- 回归测试: _______________
```

---

### Template 2: 新功能开发

```markdown
## 任务：新功能开发

### Skill Router 决策
- [ ] 规划 Skill: `writing-plans` / `create-plan`
- [ ] 执行 Skill: `subagent-driven-development` / `executing-plans`
- [ ] 前端 Skill: `senior-frontend` / `react-best-practices`
- [ ] 后端 Skill: `senior-backend` / `api-integration-specialist`
- [ ] 测试 Skill: `test-driven-development` / `senior-qa`

### 输入
- **功能名称**: _______________
- **用户故事**: 作为____，我想要____，以便____
- **设计稿/原型**: _______________

### 范围限制
- 涉及模块: _______________
- 依赖: _______________
- 禁止修改: _______________

### 验收标准
- [ ] 功能可正常访问
- [ ] 单元测试覆盖
- [ ] i18n 双语完整
- [ ] 响应式适配（375px-1920px）
- [ ] 加载/成功/失败状态完整
- [ ] 无控制台错误

### 输出
- 实现计划: `docs/plans/_______________`
- 涉及 PR: _______________
- 测试报告: _______________
```

---

### Template 3: PR 合并流程

```markdown
## 任务：PR 合并

### Skill Router 决策
- [ ] 清理 Skill: `sentry/deslop`
- [ ] 审查 Skill: `requesting-code-review` / `sentry/code-review`
- [ ] CI 修复 Skill: `gh-fix-ci` / `sentry/iterate-pr`
- [ ] 评论处理 Skill: `gh-address-comments`
- [ ] 验证 Skill: `verification-before-completion`

### 输入
- **PR 链接/编号**: _______________
- **目标分支**: _______________
- **关联 Issue**: _______________

### 范围限制
- 不丢功能: [x] 确认
- 冲突融合（非覆盖）: [x] 确认

### 验收标准
- [ ] CI 全绿
- [ ] 代码审查通过
- [ ] 无未解决评论
- [ ] 功能可在目标分支访问
- [ ] 无回归问题

### 输出
- 合并提交: _______________
- 功能验证截图: _______________
```

---

### Template 4: 数据库变更（Supabase）

```markdown
## 任务：数据库变更

### Skill Router 决策
- [ ] Schema 设计 Skill: `postgres-schema-design`
- [ ] 安全审计 Skill: `senior-security`
- [ ] 迁移执行 Skill: `senior-backend`

### 输入
- **变更类型**: [ ] 新表 [ ] 新字段 [ ] 索引 [ ] RLS
- **表名**: _______________
- **需求描述**: _______________

### 范围限制
- 幂等迁移: [x] 确认
- 禁止 DROP: [x] 确认
- RLS 策略: [x] 必须

### 验收标准
- [ ] 迁移文件命名正确 (YYYYMMDDHHMMSS_*.sql)
- [ ] 迁移可重复执行
- [ ] RLS 策略已添加
- [ ] 本地 Supabase 测试通过
- [ ] 无敏感数据暴露

### 输出
- 迁移文件: `supabase/migrations/_______________`
- RLS 策略: _______________
- 测试 SQL: _______________
```

---

### Template 5: 交易所 API 集成

```markdown
## 任务：交易所 API 集成

### Skill Router 决策
- [ ] 集成 Skill: `api-integration-specialist`
- [ ] 后端 Skill: `senior-backend`
- [ ] Schema Skill: `postgres-schema-design`
- [ ] 调试 Skill: `error-resolver`

### 输入
- **交易所**: [ ] Binance [ ] Bybit [ ] Bitget [ ] MEXC [ ] OKX [ ] KuCoin [ ] CoinEx [ ] GMX
- **API 端点**: _______________
- **字段映射**:
  - 交易所字段 → Arena 字段
  - _______________

### 范围限制
- 不存储 Secret: [x] 确认
- 频率限制: _______________
- 代理配置: _______________

### 验收标准
- [ ] API 调用成功
- [ ] 字段映射正确
- [ ] 错误重试逻辑
- [ ] 频率限制遵守
- [ ] 数据存入数据库

### 输出
- 集成代码: _______________
- 字段映射表: _______________
- 测试结果: _______________
```

---

### Template 6: i18n 去硬编码

```markdown
## 任务：i18n 去硬编码

### Skill Router 决策
- [ ] 查找 Skill: `sentry/find-bugs` (搜索硬编码)
- [ ] 执行 Skill: `task-execution-engine`
- [ ] 验证 Skill: `verification-before-completion`

### 输入
- **目标文件/目录**: _______________
- **语言**: [ ] 中文 [ ] 英文 [ ] 两者

### 范围限制
- 只处理指定范围: [x] 确认
- 不改动逻辑: [x] 确认

### 验收标准
- [ ] 无硬编码字符串
- [ ] en.json 已更新
- [ ] zh.json 已更新
- [ ] 页面显示正确
- [ ] 切换语言正常

### 输出
- 修改文件列表: _______________
- 新增 i18n key: _______________
- 翻译文本: _______________
```

---

### Template 7: 性能优化

```markdown
## 任务：性能优化

### Skill Router 决策
- [ ] 前端优化 Skill: `react-best-practices`
- [ ] 后端优化 Skill: `senior-backend`
- [ ] 数据库优化 Skill: `postgres-schema-design`
- [ ] 架构优化 Skill: `senior-architect`

### 输入
- **性能问题**: _______________
- **当前指标**: LCP=___ FID=___ CLS=___
- **目标指标**: LCP<___ FID<___ CLS<___

### 范围限制
- 涉及组件/API: _______________
- 不重构: [x] 确认

### 验收标准
- [ ] 达到目标指标
- [ ] 无功能回归
- [ ] 无新增 Bundle 大小（或减少）
- [ ] Lighthouse 评分提升

### 输出
- 优化前指标: _______________
- 优化后指标: _______________
- 优化措施: _______________
```

---

### Template 8: 安全审计

```markdown
## 任务：安全审计

### Skill Router 决策
- [ ] 审计 Skill: `senior-security`
- [ ] Bug 查找 Skill: `sentry/find-bugs`
- [ ] 代码审查 Skill: `sentry/code-review`

### 输入
- **审计范围**: _______________
- **关注点**: [ ] 认证 [ ] 授权 [ ] 注入 [ ] XSS [ ] CSRF [ ] RLS

### 范围限制
- 只读审计（不修改）: [x] 确认
- 输出报告格式: _______________

### 验收标准
- [ ] 完成 OWASP Top 10 检查
- [ ] RLS 策略验证
- [ ] 敏感数据处理验证
- [ ] 输出结构化报告

### 输出
- 发现问题:
  - Critical: _______________
  - High: _______________
  - Medium: _______________
  - Low: _______________
- 修复建议: _______________
```

---

### Template 9: UI/UX 优化

```markdown
## 任务：UI/UX 优化

### Skill Router 决策
- [ ] 设计 Skill: `ui-ux-pro-max`
- [ ] 前端 Skill: `senior-frontend`
- [ ] 性能 Skill: `react-best-practices`

### 输入
- **优化目标**: _______________
- **当前问题**: _______________
- **设计参考**: _______________

### 范围限制
- 涉及组件: _______________
- 保持一致性: [x] 确认
- 响应式: [x] 必须

### 验收标准
- [ ] 遵循 design-tokens.ts
- [ ] 响应式适配 (375px-1920px)
- [ ] 触摸目标 >= 44x44px
- [ ] 对比度符合 WCAG AA
- [ ] 有 hover/active/disabled 状态

### 输出
- 修改组件: _______________
- 视觉对比截图: _______________
```

---

### Template 10: CI/CD 问题修复

```markdown
## 任务：CI/CD 问题修复

### Skill Router 决策
- [ ] 首选 Skill: `gh-fix-ci`
- [ ] 备选 Skill: `sentry/iterate-pr`
- [ ] DevOps Skill: `senior-devops`

### 输入
- **PR/分支**: _______________
- **失败 Check**: _______________
- **错误日志**: _______________

### 范围限制
- 最小修复: [x] 确认
- 不改变 CI 配置（除非必要）: [x] 确认

### 验收标准
- [ ] CI 全绿
- [ ] 无新增跳过测试
- [ ] 无降低覆盖率

### 输出
- 根因: _______________
- 修复提交: _______________
- CI 状态截图: _______________
```

---

## 审计检查清单

完成任务后，对照此清单：

### 可用但未使用的 Skill
- [ ] 是否有更适合的 Skill 被忽略？
- [ ] 是否手动完成了可自动化的步骤？

### 使用但未产生价值的 Skill
- [ ] 是否调用了 Skill 但忽略了输出？
- [ ] 是否只是"走流程"而非实际利用？

### 改进建议
- [ ] 记录本次经验到 `docs/skill-learnings.md`
- [ ] 如需新 Skill，使用 `skill-creator` 创建

---

## 新 Skill 集成流程

当检测到 `~/.claude/skills/` 或 `.claude/skills/` 中新增 Skill：

1. **登记到 SKILL INVENTORY**
   - 名称、Arena任务、输入、输出、风险

2. **更新 ARENA SKILL ROUTER**
   - 至少添加 1 个路由规则

3. **更新现有模板**
   - 在相关模板的 Skill Router 决策中添加新选项

4. **创建示例任务**
   - 使用新 Skill 完成一个真实 Arena 任务
   - 记录到 `docs/skill-examples/`
