# Arena Harness Architecture

> Based on [Anthropic's Harness Design for Long-Running Applications](https://www.anthropic.com/engineering/harness-design-long-running-apps)
> and [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

## TL;DR

Arena 已有强大的 pipeline 监控和 10-agent 虚拟团队，但缺乏 Anthropic harness 的三个核心模式：
1. **对抗式评估** (Generator-Evaluator adversarial loop)
2. **结构化 handoff** (structured state passing between agents/phases)
3. **反馈闭环** (post-ship learnings → agent improvement)

本设计将 Anthropic 三 Agent 架构（Planner → Generator → Evaluator）应用到 Arena 的两个领域：
- **Pipeline Harness** — 数据管道的可靠性和质量
- **Development Harness** — 多 Agent 开发工作流的质量和一致性

---

## 1. Pipeline Harness（数据管道）

### 1.1 现状 vs 目标

| 维度 | 现状 (v1) | Harness (v2) |
|------|-----------|-------------|
| 故障恢复 | 整个 job 重启 | 从 checkpoint 恢复 |
| 阶段衔接 | 时间触发 (5min dedup) | 事件驱动 + metadata handoff |
| 数据验证 | 降级检测 (>30% drop) | 独立 Evaluator agent 全面验证 |
| 问题追踪 | 每 job 独立日志 | 分布式 trace_id 贯穿全链路 |
| 学习能力 | 人工回顾 | 自动 failure pattern → config 调整 |

### 1.2 三 Agent 映射

```
┌─────────────────────────────────────────────────────────────┐
│                    PIPELINE HARNESS                          │
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │ PLANNER  │───▶│GENERATOR │───▶│EVALUATOR │              │
│  │ (调度器)  │    │ (执行器)  │    │ (验证器)  │              │
│  └──────────┘    └──────────┘    └──────────┘              │
│       │               │               │                     │
│  决定做什么        执行 + 检查点      独立验证数据质量          │
│  优先级排序        故障自动恢复       发现 Generator 遗漏      │
│  资源分配          结构化输出         反馈到下次 Plan           │
│                                                             │
│  ┌──────────────────────────────────────────┐               │
│  │           FEEDBACK LOOP                   │               │
│  │  Evaluator 发现问题 → 记录 pattern →      │               │
│  │  Planner 下次调整优先级/参数               │               │
│  └──────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 Planner: Pipeline Scheduler

**职责**: 根据数据新鲜度、历史成功率、资源可用性，决定每轮要做什么。

```typescript
// lib/harness/pipeline-planner.ts

interface PipelinePlan {
  trace_id: string                    // UUID，贯穿整个执行链
  created_at: string                  // ISO timestamp
  phase: 'fetch' | 'enrich' | 'compute'
  platforms: PlatformPlan[]
  priority_reason: string             // 为什么选这些 platform
  resource_budget: {
    max_duration_ms: number           // 预算时间
    max_api_calls: number             // API 调用预算
  }
}

interface PlatformPlan {
  platform: string
  priority: number                    // 1=highest
  last_success: string | null         // 上次成功时间
  staleness_hours: number             // 数据陈旧度
  consecutive_failures: number        // 连续失败次数
  strategy: 'normal' | 'retry' | 'skip' | 'vps_fallback'
  checkpoint?: string                 // 上次中断的 checkpoint
}
```

**决策逻辑**:
```
1. 读取 pipeline_state 所有平台的最近状态
2. 按 staleness × priority_weight 排序
3. 跳过 circuit breaker OPEN 的平台
4. 对连续失败 3+ 的平台：strategy = 'vps_fallback'
5. 对有 checkpoint 的平台：从断点恢复
6. 输出 PipelinePlan JSON → 传给 Generator
```

### 1.4 Generator: Pipeline Executor (带 Checkpointing)

**核心改进**: 每个平台处理完成后写 checkpoint，崩溃后从断点恢复。

```typescript
// lib/harness/pipeline-executor.ts

interface ExecutionCheckpoint {
  trace_id: string
  phase: string
  completed_platforms: string[]       // 已完成的平台
  current_platform: string | null     // 正在处理的平台
  current_offset: number              // 当前 offset（enrichment 用）
  records_processed: number
  errors: PlatformError[]
  started_at: string
  last_checkpoint_at: string
}

// 关键：每处理完一个平台就写 checkpoint
async function executeWithCheckpoint(plan: PipelinePlan) {
  const checkpoint = await loadCheckpoint(plan.trace_id)
    ?? createCheckpoint(plan.trace_id)

  for (const platformPlan of plan.platforms) {
    // 跳过已完成的
    if (checkpoint.completed_platforms.includes(platformPlan.platform)) continue

    checkpoint.current_platform = platformPlan.platform
    await saveCheckpoint(checkpoint)

    try {
      const result = await executePlatform(platformPlan)
      checkpoint.completed_platforms.push(platformPlan.platform)
      checkpoint.records_processed += result.count
      await saveCheckpoint(checkpoint)
    } catch (error) {
      checkpoint.errors.push({
        platform: platformPlan.platform,
        error: error.message,
        at: new Date().toISOString()
      })
      await saveCheckpoint(checkpoint)
      // 继续下一个平台，不中断整个 batch
    }
  }

  return checkpoint
}
```

**Handoff 到 Evaluator**:
```typescript
// Generator 完成后输出结构化结果
interface ExecutionResult {
  trace_id: string
  plan: PipelinePlan                  // 原始计划
  checkpoint: ExecutionCheckpoint     // 最终状态
  summary: {
    total_platforms: number
    succeeded: number
    failed: number
    records_written: number
    duration_ms: number
  }
  artifacts: {
    platforms_updated: string[]       // Evaluator 需要验证这些
    snapshot_ids?: string[]           // 写入的 snapshot IDs
  }
}
```

### 1.5 Evaluator: Pipeline Validator

**核心理念**: 独立于 Generator，用不同路径验证数据质量。对应 Anthropic 的"分离做事的 agent 和评判的 agent"。

```typescript
// lib/harness/pipeline-evaluator.ts

interface EvaluationResult {
  trace_id: string
  overall_score: number               // 0-100
  passed: boolean                     // score >= 70
  checks: EvaluationCheck[]
  recommendations: string[]           // 给 Planner 的反馈
  issues: EvaluationIssue[]
}

interface EvaluationCheck {
  name: string
  category: 'completeness' | 'freshness' | 'consistency' | 'anomaly'
  passed: boolean
  score: number                       // 0-100
  details: string
}

// Evaluator 运行的独立检查（不信任 Generator 的自我报告）
const EVALUATION_CHECKS = [
  // 完整性检查
  {
    name: 'record_count_consistency',
    check: async (result: ExecutionResult) => {
      // 独立查询 DB，验证记录数 vs Generator 报告的一致
      const dbCount = await countRecentRecords(result.artifacts.platforms_updated)
      const reported = result.summary.records_written
      return { passed: Math.abs(dbCount - reported) / reported < 0.05 }
    }
  },

  // 新鲜度检查
  {
    name: 'data_freshness',
    check: async (result: ExecutionResult) => {
      // 验证写入的数据时间戳是否合理
      const staleCount = await countStaleRecords(result.artifacts.platforms_updated, '2h')
      return { passed: staleCount === 0 }
    }
  },

  // 异常检测（对抗 Generator 可能写入的脏数据）
  {
    name: 'roi_anomaly_detection',
    check: async (result: ExecutionResult) => {
      // 检查 ROI 是否在合理范围 (-100% to +50000%)
      const anomalies = await findROIAnomalies(result.artifacts.platforms_updated)
      return { passed: anomalies.length === 0, details: anomalies }
    }
  },

  // 跨平台一致性
  {
    name: 'cross_platform_consistency',
    check: async (result: ExecutionResult) => {
      // 检查同一 trader 在不同平台的数据是否矛盾
      const conflicts = await findCrossPlatformConflicts()
      return { passed: conflicts.length === 0 }
    }
  },

  // 覆盖率检查
  {
    name: 'enrichment_coverage',
    check: async (result: ExecutionResult) => {
      // 验证 enrichment 后 >80% traders 有完整指标
      const coverage = await measureEnrichmentCoverage(result.artifacts.platforms_updated)
      return { passed: coverage.overall >= 0.80, score: coverage.overall * 100 }
    }
  },

  // 排行榜完整性
  {
    name: 'leaderboard_integrity',
    check: async (result: ExecutionResult) => {
      // 验证排行榜无重复、无缺失、分数合理
      const issues = await validateLeaderboardIntegrity()
      return { passed: issues.length === 0 }
    }
  }
]
```

**Evaluator 反馈闭环**:
```typescript
// Evaluator 发现问题后，写回 pipeline_state 供 Planner 下次读取
async function feedbackToPlanner(evaluation: EvaluationResult) {
  for (const issue of evaluation.issues) {
    await PipelineState.set(
      `evaluator:feedback:${issue.platform}`,
      {
        issue_type: issue.type,
        severity: issue.severity,
        recommendation: issue.recommendation,
        last_seen: new Date().toISOString(),
        occurrence_count: (await getOccurrenceCount(issue.platform, issue.type)) + 1
      }
    )
  }

  // 如果同一问题连续出现 3 次，升级为 critical
  // → Planner 下次会调整 strategy（如 vps_fallback、skip、或 alert 人工介入）
}
```

### 1.6 Pipeline Trace（分布式追踪）

```typescript
// lib/harness/pipeline-trace.ts

// 每个 trace 记录完整的 fetch → enrich → compute → validate 链路
interface PipelineTrace {
  trace_id: string                    // UUID, 生命周期贯穿整条链
  phases: {
    plan: { started_at: string; plan: PipelinePlan }
    execute: { started_at: string; checkpoint: ExecutionCheckpoint }
    evaluate: { started_at: string; result: EvaluationResult }
  }
  total_duration_ms: number
  final_status: 'success' | 'partial' | 'failed'
}

// 存入 pipeline_traces 表，供回顾分析
// → /admin/monitoring 可以查看每条 trace 的完整链路
```

---

## 2. Development Harness（开发工作流）

### 2.1 现状 vs 目标

| 维度 | 现状 (v1) | Harness (v2) |
|------|-----------|-------------|
| Agent 协作 | conductor.json 串行/并行 | 结构化 handoff + context cache |
| 质量评估 | QA 报告（合作式） | Adversarial Evaluator（对抗式） |
| 上下文管理 | 每个 agent 独立读文件 | Shared Context Layer |
| 一致性检查 | 无 | Coherence Checker |
| 学习能力 | 人工 /retro | 自动 failure → skill prompt 更新 |
| Sprint 合约 | 无（spec 直接实现） | Generator-Evaluator 协商验收标准 |

### 2.2 三 Agent 映射

```
┌──────────────────────────────────────────────────────────────────┐
│                   DEVELOPMENT HARNESS                            │
│                                                                  │
│  ┌──────────┐     ┌──────────┐     ┌──────────────┐            │
│  │ PLANNER  │────▶│GENERATOR │────▶│  EVALUATOR   │            │
│  │          │     │          │     │  (Adversarial)│            │
│  └──────────┘     └──────────┘     └──────────────┘            │
│       │                │                  │                      │
│  /plan-ceo-review  /implement-spec    NEW: 独立对抗式            │
│  /plan-eng-review  atomic commits     Playwright 测试            │
│  specs/*.md        git checkpoint     不信任 Generator            │
│                                       penalize AI slop            │
│                                                                  │
│  ┌─────────────────────────────────────────────────┐            │
│  │              CONTEXT LAYER                       │            │
│  │  Shared cache · Coherence check · Trace log      │            │
│  └─────────────────────────────────────────────────┘            │
│                                                                  │
│  ┌─────────────────────────────────────────────────┐            │
│  │              FEEDBACK LOOP                       │            │
│  │  Post-ship bugs → QA prompt tuning →             │            │
│  │  Evaluator criteria update → Memory update       │            │
│  └─────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 Adversarial Evaluator（对抗式评估 Agent）

**为什么需要**: Anthropic 的研究证明，agent "identify legitimate issues, then talk itself into deciding they weren't a big deal"。Arena 当前的 QA 是合作式的——和 Generator 使用同一个 context，天然偏向乐观。

```markdown
# .claude/skills/arena-adversarial-evaluator/SKILL.md

## Role
你是一个**对抗式评估者**。你的唯一目标是找到 Generator 遗漏的问题。
你不是合作者，你是质量守门人。

## 核心原则
1. **零信任**: 不相信 Generator 的自我报告。自己验证一切。
2. **AI Slop 检测**: 主动寻找 AI 生成代码的常见问题：
   - 过度工程（不需要的抽象）
   - 虚假错误处理（catch 后 console.log 但不处理）
   - 幻觉 API（调用不存在的函数/端点）
   - 未测试的边界条件
3. **Playwright 实测**: 用浏览器自动化实际运行功能，不只是读代码。
4. **评分标准**（借鉴 Anthropic 的四维评分）:
   - **功能完整性** (0-25): 所有 acceptance criteria 是否真正工作？
   - **代码质量** (0-25): TypeScript strict, 无 any, 无 silent failures?
   - **用户体验** (0-25): 真实用户能完成核心操作吗？
   - **鲁棒性** (0-25): 错误状态、空数据、网络断开怎么办？

## 工作流程
1. 读取 Generator 的 spec 和 commit history
2. **不读 Generator 的测试** — 自己写验证逻辑
3. 用 Playwright 访问每个改动的页面
4. 用 API 请求验证每个改动的端点
5. 检查数据库状态是否正确
6. 输出结构化评估报告

## Sprint 合约模式
在 Generator 开始实现前，与 Evaluator 协商：
- Generator 提出："我将实现 X, Y, Z"
- Evaluator 提出："我将用以下方式验证 X, Y, Z"
- 双方达成 Contract（JSON 格式）
- 实现完成后，Evaluator 严格按 Contract 验证

## 输出格式
```json
{
  "score": 72,
  "verdict": "NEEDS_REWORK",
  "blocking_issues": [
    {
      "severity": "critical",
      "description": "Portfolio tab returns 500 for hyperliquid traders",
      "evidence": "screenshot_001.png, API response: {error: 'timeout'}",
      "suggested_fix": "Add timeout handling in lib/data/portfolio.ts"
    }
  ],
  "non_blocking_issues": [...],
  "ai_slop_detected": [
    "Unnecessary try-catch wrapper in utils/format.ts:42",
    "Unused import of 'useEffect' in TraderCard.tsx"
  ],
  "pass_threshold": 80,
  "iterations_remaining": 3
}
```

## 迭代规则
- score < 60: NEEDS_REWORK, Generator 必须修复 blocking issues
- score 60-79: CONDITIONAL_PASS, 修复 critical 后可继续
- score >= 80: PASS, 可以进入 /ship
- 最多 5 轮迭代（避免无限循环）
- 每轮 Evaluator 分数必须单调不降（否则回滚到上一轮）
```

### 2.4 Shared Context Layer

**问题**: 当前每个 agent 独立读取文件，导致 token 浪费和上下文不一致。

```typescript
// lib/harness/context-layer.ts

interface SharedContext {
  // 在 harness session 开始时构建一次，所有 agent 共享
  project_summary: string             // CLAUDE.md 摘要
  current_sprint: string              // PROGRESS.md 关键信息
  recent_changes: string              // git log --oneline -20
  architecture_snapshot: {
    active_platforms: string[]
    api_routes_count: number
    recent_migrations: string[]
    test_coverage: number
  }
  evaluator_feedback: string[]        // 上次 Evaluator 的反馈
  planner_decisions: string[]         // Planner 的关键决策
}

// 每个 agent 只接收与自己相关的 context slice
function getContextForAgent(agent: AgentRole, full: SharedContext): string {
  switch (agent) {
    case 'planner':
      return `${full.project_summary}\n${full.current_sprint}\n${full.evaluator_feedback}`
    case 'generator':
      return `${full.architecture_snapshot}\n${full.recent_changes}`
    case 'evaluator':
      return `${full.planner_decisions}\n${full.architecture_snapshot}`
  }
}
```

### 2.5 Coherence Checker

**问题**: CEO 说 "expand scope" 但 Eng review 说 "ship now"，没有机制检测矛盾。

```typescript
// lib/harness/coherence-checker.ts

interface AgentOutput {
  agent: string
  verdict: string                     // APPROVED, NEEDS_REWORK, etc.
  scope_direction: 'expand' | 'maintain' | 'reduce'
  key_recommendations: string[]
  blockers: string[]
}

function checkCoherence(outputs: AgentOutput[]): CoherenceReport {
  const conflicts: Conflict[] = []

  // 检查 scope 方向矛盾
  const scopeDirections = new Set(outputs.map(o => o.scope_direction))
  if (scopeDirections.has('expand') && scopeDirections.has('reduce')) {
    conflicts.push({
      type: 'scope_conflict',
      agents: outputs.filter(o => ['expand', 'reduce'].includes(o.scope_direction)),
      resolution: 'escalate_to_user'
    })
  }

  // 检查 blocker 矛盾（一个说 ready，另一个有 blockers）
  const readyAgents = outputs.filter(o => o.verdict === 'APPROVED')
  const blockedAgents = outputs.filter(o => o.blockers.length > 0)
  if (readyAgents.length > 0 && blockedAgents.length > 0) {
    conflicts.push({
      type: 'readiness_conflict',
      agents: [...readyAgents, ...blockedAgents],
      resolution: 'prioritize_blockers'
    })
  }

  return {
    coherent: conflicts.length === 0,
    conflicts,
    recommendation: conflicts.length > 0
      ? 'Resolve conflicts before proceeding'
      : 'All agents aligned, safe to proceed'
  }
}
```

### 2.6 Feedback Loop: Post-Ship Learning

**问题**: 如果 ship 后发现 bug，没有自动反馈到 QA/Evaluator 的 prompt 里。

```typescript
// lib/harness/feedback-loop.ts

// 当 /retro 或 health-monitor 发现 post-ship bug 时触发
async function recordPostShipIssue(issue: PostShipIssue) {
  // 1. 确定哪个 gate 应该捕获这个问题
  const responsibleGate = classifyIssue(issue)
  // → 'evaluator' | 'qa' | 'eng_review' | 'design_audit'

  // 2. 记录 miss pattern
  await appendToFile('.claude/harness/miss-log.jsonl', {
    date: new Date().toISOString(),
    issue: issue.description,
    responsible_gate: responsibleGate,
    root_cause: issue.root_cause,
    should_have_checked: issue.prevention_check
  })

  // 3. 如果同类 miss 出现 3+ 次，自动更新 Evaluator criteria
  const missCount = await countSimilarMisses(responsibleGate, issue.category)
  if (missCount >= 3) {
    await appendEvaluatorCheck({
      name: `auto_${issue.category}_check`,
      description: `Auto-added after ${missCount} post-ship misses: ${issue.prevention_check}`,
      added_at: new Date().toISOString()
    })
    await sendAlert(`🔄 Evaluator auto-updated: added check for "${issue.category}" (${missCount} misses)`)
  }
}
```

---

## 3. Implementation Plan

### Phase 1: Pipeline Checkpointing（1 天）
**最高价值，最低风险。**

```
修改文件：
- lib/harness/pipeline-checkpoint.ts    (NEW — checkpoint CRUD)
- app/api/cron/batch-fetch-traders/route.ts  (改 — 加 checkpoint)
- app/api/cron/batch-enrich/route.ts         (改 — 加 checkpoint + offset)
- lib/services/pipeline-state.ts             (改 — 加 checkpoint helpers)
```

**验收标准**:
- [ ] batch-fetch 中途崩溃后，下次运行从断点恢复
- [ ] batch-enrich 中途崩溃后，从 offset 恢复
- [ ] checkpoint 数据存在 pipeline_state 表，可查询
- [ ] 正常运行完成后清理 checkpoint

### Phase 2: Structured Handoffs + Trace（1 天）

```
修改文件：
- lib/harness/pipeline-trace.ts          (NEW — trace_id 生成和传播)
- lib/cron/trigger-chain.ts              (改 — 传递 trace_id + metadata)
- app/api/cron/compute-leaderboard/route.ts (改 — 接收 trace metadata)
- supabase/migrations/00XXX_pipeline_traces.sql (NEW — traces 表)
```

**验收标准**:
- [ ] 每次 pipeline 运行生成唯一 trace_id
- [ ] trace_id 从 fetch → enrich → compute → cache 全链路传播
- [ ] `/admin/monitoring` 可查看完整 trace
- [ ] trigger-chain 传递 platforms_updated 列表

### Phase 3: Pipeline Evaluator（2 天）

```
修改文件：
- lib/harness/pipeline-evaluator.ts      (NEW — 6 项独立检查)
- app/api/cron/pipeline-evaluate/route.ts (NEW — cron 触发评估)
- vercel.json                            (改 — 加评估 cron)
- lib/alerts/send-alert.ts               (改 — 加评估报告格式)
```

**验收标准**:
- [ ] 每次 compute-leaderboard 完成后自动触发 Evaluator
- [ ] Evaluator 独立查询 DB 验证数据（不依赖 Generator 报告）
- [ ] 评估结果写入 pipeline_state 供 Planner 读取
- [ ] 发现 critical issue 时 Telegram 告警

### Phase 4: Adversarial Dev Evaluator（2 天）

```
新建文件：
- .claude/skills/arena-adversarial-evaluator/SKILL.md
- .claude/commands/evaluate.md           (NEW — /evaluate 命令)
- .claude/harness/miss-log.jsonl         (NEW — post-ship miss 记录)
```

**验收标准**:
- [ ] `/evaluate` 命令启动独立 Evaluator agent
- [ ] Evaluator 使用 Playwright 实际测试页面
- [ ] Sprint Contract 模式：Generator-Evaluator 在实现前达成验收标准
- [ ] 评分系统：功能/质量/UX/鲁棒性 四维评分

### Phase 5: Context Layer + Coherence（1 天）

```
新建/修改文件：
- lib/harness/context-layer.ts           (NEW — shared context builder)
- lib/harness/coherence-checker.ts       (NEW — 矛盾检测)
- .claude/conductor.json                 (改 — 加 coherence check phase)
```

**验收标准**:
- [ ] conductor 工作流中 review_phase 结束后自动运行 coherence check
- [ ] 检测到矛盾时暂停并 escalate 给用户
- [ ] Shared context 减少每个 agent 的独立文件读取量

### Phase 6: Feedback Loop（1 天）

```
新建/修改文件：
- lib/harness/feedback-loop.ts           (NEW — post-ship learning)
- scripts/openclaw/post-ship-monitor.mjs (NEW — 自动检测 post-ship issues)
- .claude/harness/evaluator-criteria.json (NEW — 可热更新的评估标准)
```

**验收标准**:
- [ ] post-ship bug 自动归因到应该捕获它的 gate
- [ ] 同类 miss ≥3 次自动更新 Evaluator criteria
- [ ] miss-log.jsonl 可被 /retro 读取和分析

---

## 4. Conductor v2: Harness-Aware Workflow

```jsonc
// .claude/conductor.json v2
{
  "workflows": {
    "harness_full": {
      "description": "Full harness workflow with adversarial evaluation",
      "phases": {
        "plan_phase": {
          "parallel": ["ceo_review", "eng_review"],
          "output": "plan_outputs/"
        },
        "coherence_check": {
          "depends_on": "plan_phase",
          "agent": "coherence_checker",
          "input": "plan_outputs/",
          "gate": true  // 矛盾时暂停
        },
        "contract_phase": {
          "depends_on": "coherence_check",
          "agents": ["generator", "evaluator"],
          "mode": "negotiate",  // 协商验收标准
          "output": "sprint_contract.json"
        },
        "build_phase": {
          "depends_on": "contract_phase",
          "agent": "generator",
          "input": "sprint_contract.json",
          "checkpoint_interval": "per_acceptance_criterion"
        },
        "evaluate_phase": {
          "depends_on": "build_phase",
          "agent": "adversarial_evaluator",
          "input": "sprint_contract.json",
          "max_iterations": 5,
          "pass_threshold": 80
        },
        "ship_phase": {
          "depends_on": "evaluate_phase",
          "gate": "eng_review.passed && evaluator.score >= 80",
          "agent": "release_manager"
        },
        "post_ship": {
          "depends_on": "ship_phase",
          "parallel": ["doc_release", "feedback_loop_init"]
        }
      }
    }
  }
}
```

---

## 5. Key Anthropic Insights Applied to Arena

| Anthropic 原则 | Arena 应用 |
|---------------|-----------|
| **分离 Generator 和 Evaluator** | Pipeline: 执行器 vs 验证器分离。Dev: 实现者 vs 对抗式测试者分离 |
| **Context resets > compaction** | 每个 agent 获得 fresh context + structured handoff，不是压缩后的长 context |
| **Sprint Contract** | Generator-Evaluator 在实现前协商验收标准，避免"做完了才发现需求不对" |
| **Evaluator 需要大量 prompt tuning** | 初始 Evaluator prompt 会偏乐观，需要从 miss-log 持续调优 |
| **每个组件编码一个"模型做不到"的假设** | 定期 stress test：哪些 harness 组件还 load-bearing？哪些可以移除？ |
| **Progressive simplification** | 随模型能力提升，逐步简化 harness（如 Opus 4.6 不需要 sprint decomposition） |
| **Sub-agents as context firewalls** | 用 sub-agent 做重型搜索/分析，只返回摘要给 parent context |
| **Checkpoint-resume for context** | pipeline-checkpoint.ts + claude-progress.txt 模式 |

---

## 6. Cost & Performance Estimates

| Phase | Token 预算/次 | 频率 | 月成本估算 |
|-------|-------------|------|-----------|
| Pipeline Planner | ~2K | 每 batch (8x/day) | $2 |
| Pipeline Evaluator | ~10K | 每 compute (48x/day) | $50 |
| Dev Evaluator | ~50K | 每个 feature (5x/week) | $30 |
| Coherence Check | ~5K | 每个 review (5x/week) | $3 |
| Feedback Loop | ~1K | 每个 issue | ~$1 |
| **Total** | | | **~$86/月** |

Pipeline harness 主要成本在 Evaluator 的独立 DB 查询（Supabase 免费额度内）。
Dev harness 成本在 Playwright 测试的 token（截图 + 页面分析）。

---

## 7. Success Metrics

| 指标 | 当前基线 | 目标 (30 天) | 测量方式 |
|------|---------|-------------|---------|
| Pipeline 中途失败恢复时间 | 重新运行全 batch (3-5min) | 从 checkpoint 恢复 (<30s) | pipeline_traces 表 |
| 数据异常发现时间 | 人工发现 (hours-days) | Evaluator 自动发现 (<5min) | evaluator alerts |
| Post-ship bug 率 | ~3/week | <1/week | miss-log.jsonl |
| Agent coherence conflicts | 未检测 | 100% 检测率 | coherence reports |
| Evaluator 真阳性率 | N/A | >80% (不误报) | human review sample |
| Feature 平均迭代轮数 | 1 (无 eval loop) | 2-3 (有 eval 后更高质量) | commit history |

---

## Sources

- [Harness design for long-running application development — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Effective harnesses for long-running agents — Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [The GAN-Style Agent Loop — Epsilla](https://www.epsilla.com/blogs/anthropic-harness-engineering-multi-agent-gan-architecture)
- [Skill Issue: Harness Engineering for Coding Agents — HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [2026 Is Agent Harnesses — Aakash Gupta / Medium](https://aakashgupta.medium.com/2025-was-agents-2026-is-agent-harnesses-heres-why-that-changes-everything-073e9877655e)
- [What Is Harness Engineering? Complete Guide 2026 — NxCode](https://www.nxcode.io/resources/news/what-is-harness-engineering-complete-guide-2026)
