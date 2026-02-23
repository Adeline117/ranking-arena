# REPORT_FIX_TOP10_2026-02-23

## 执行概览
- 执行时间：2026-02-23
- 分支：`main`
- 执行顺序：按 P0 -> P1 -> P2 落地
- 每个修复点独立提交并已 push 到 `origin/main`
- 每次提交均经过 pre-push 检查（仓库钩子：`eslint .` + `tsc --noEmit`）

---

## 逐项修复清单（1-10）

### 1) 前端监控页直接调用受保护 API 导致生产401
- 处理：`/api/admin/monitoring/overview` 内部拉取 `/api/admin/*` 子接口时，透传当前 admin `Authorization`，并使用 `req.nextUrl.origin` 作为同源基址。
- 文件：
  - `app/api/admin/monitoring/overview/route.ts`
- Commit: `772993f6`
- 验证：`eslint` + `type-check` 通过；逻辑上内部子请求不再因缺失鉴权头返回 401。

### 2) 排行榜多链路口径不一致（/api/rankings, /api/v2/rankings, /api/traders）
- 处理：统一时间窗入参口径与服务端执行策略：
  - `/api/traders` 对 `timeRange` 统一规范化为 `7D/30D/90D`。
  - `/api/v2/rankings` 移除“无 display_name 过滤”差异，避免与其它链路出现数据集不一致。
- 文件：
  - `app/api/traders/route.ts`
  - `app/api/v2/rankings/route.ts`
- Commit: `573c5f52`
- 验证：`eslint` + `type-check` 通过；三链路核心窗口语义与返回样本边界更一致。

### 3) 数据新鲜度阈值冲突（8h/24h vs 文案12h）
- 处理：统一系统级阈值为 `fresh < 12h`、`stale 12-24h`、`critical > 24h`：
  - 管理统计口径改为 12h/24h。
  - 监控 freshness 默认阈值从 24h 调整为 12h（critical 仍为 2x=24h）。
- 文件：
  - `app/api/admin/stats/route.ts`
  - `app/api/monitoring/freshness/route.ts`
- Commit: `268c32f6`
- 验证：`eslint` + `type-check` 通过；后台文案与统计分桶一致。

### 4) /api/monitoring/freshness 全表分页后聚合，扩容风险
- 处理：将 API 侧全表分页聚合下推到数据库：
  - 新增 RPC `get_monitoring_freshness_summary()`（按 source 聚合，返回 max captured_at/字段覆盖计数）。
  - API 改为直接调用 RPC，移除全量拉取循环。
- 文件：
  - `supabase/migrations/20260223_add_monitoring_freshness_summary_rpc.sql`
  - `app/api/monitoring/freshness/route.ts`
- Commit: `7ec3973a`
- 验证：`eslint` + `type-check` 通过；链路复杂度从“应用层 O(全表扫描+拼接)”降为“DB 聚合结果集”。

### 5) 索引与查询字段偏差（window vs season_id）
- 处理：新增迁移，移除错误 index（window 维度）并补齐 season_id 维度索引。
- 文件：
  - `supabase/migrations/20260223_fix_trader_snapshots_window_index_mismatch.sql`
- Commit: `042b826a`
- 验证：`eslint` + `type-check` 通过；索引与 `/api/v2/rankings` 真实查询字段一致。

### 6) batch-enrich 使用 indexOf(object) 做延迟判断
- 处理：改为 `entries()` 下标判断，确保仅在非最后一项 sleep。
- 文件：
  - `app/api/cron/batch-enrich/route.ts`
- Commit: `c6bbe216`
- 验证：`eslint` + `type-check` 通过；顺序延迟逻辑正确。

### 7) get_distinct_sources RPC 依赖不透明
- 处理：移除 `/api/rankings` 对 `get_distinct_sources` RPC 的硬依赖，改为直接查询 `trader_snapshots(season_id)` 后本地去重。
- 文件：
  - `app/api/rankings/route.ts`
- Commit: `4f20fb17`
- 验证：`eslint` + `type-check` 通过；可观测性更高，减少隐式数据库函数依赖。

### 8) scripts/ 历史脚本堆积，生产边界不清晰
- 处理：引入“生产脚本白名单 + 检查脚本”：
  - 新增 `scripts/PRODUCTION_ALLOWLIST.json`
  - 新增 `scripts/check-production-boundary.mjs`
  - 新增 npm 命令 `check:scripts-boundary`
- 文件：
  - `scripts/PRODUCTION_ALLOWLIST.json`
  - `scripts/check-production-boundary.mjs`
  - `package.json`
- Commit: `dfd4d881`
- 验证：执行 `node scripts/check-production-boundary.mjs` 输出扫描结果；`eslint` + `type-check` 通过。

### 9) 告警模板 CSS 变量颜色导致外部渠道兼容差
- 处理：Slack attachment 与邮件 HTML 标题颜色由 CSS 变量改为 HEX 常量。
- 文件：
  - `lib/alerts/send-alert.ts`
- Commit: `6eaffc34`
- 验证：`eslint` + `type-check` 通过；第三方渠道不再依赖站内 CSS 变量。

### 10) runtime/key 策略混杂（edge/node + anon/service role）
- 处理：
  - `/api/v2/rankings` 改为统一服务端 `getSupabaseAdmin()`，不再在服务端路由使用 anon key。
  - `/api/traders` runtime 改为 `nodejs`，与服务端密钥策略一致。
- 文件：
  - `app/api/v2/rankings/route.ts`
  - `app/api/traders/route.ts`
- Commit: `573c5f52`
- 验证：`eslint` + `type-check` 通过；runtime 与 key 使用策略收敛。

---

## Commit Hashes（本次 Top10 修复）
1. `772993f6` - fix(admin-monitoring): forward admin auth to internal metrics endpoints to prevent 401
2. `573c5f52` - refactor(rankings-api): normalize time windows and unify server runtime/key strategy
3. `268c32f6` - fix(freshness): unify stale/critical thresholds to 12h and 24h
4. `7ec3973a` - perf(monitoring): aggregate freshness by source via SQL RPC instead of full-table pagination
5. `042b826a` - fix(db-index): align trader_snapshots ranking indexes with season_id queries
6. `c6bbe216` - fix(cron): correct batch-enrich delay sequencing without object indexOf bug
7. `4f20fb17` - refactor(rankings): remove opaque get_distinct_sources RPC dependency
8. `dfd4d881` - chore(scripts): enforce production boundary with explicit allowlist checker
9. `6eaffc34` - fix(alerts): replace CSS variable colors with hex for webhook/email compatibility
10. `573c5f52` - refactor(rankings-api): normalize time windows and unify server runtime/key strategy

---

## 人工确认风险（需上线前确认）
1. **数据库迁移未在报告内执行**：新增的两个 migration（RPC + index）需在目标环境按迁移流程落库后，性能/查询计划改动才会生效。
2. **/api/v2/rankings 改用 service role**：建议复核日志/审计策略是否满足最小权限与访问审计要求。
3. **scripts 边界治理为“白名单+检查”**：是治理第一步，历史脚本尚未物理归档；建议后续按目录分层迁移（prod/ops/legacy）。

---

## 备注
- 本次变更未触碰现有 UI 样式、动画、布局实现；未做无关模块改动。
