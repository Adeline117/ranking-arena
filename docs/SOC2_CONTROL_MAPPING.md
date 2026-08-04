# SOC 2 控制映射（Trust Service Criteria）

> 2026-07-02 首版。把 Arena **已具备**的工程控制映射到 SOC 2 五大信任服务准则，
> 作为尽调/审计的起点。状态：✅ 已具备 / 🟡 部分 / ⬜ 缺口(→ 指向计划)。
> 本文档为手写清单；正式 SOC 2 审计需 Vanta/Drata 类工具自动化取证。
> 最近复核：2026-08-04。

## CC — Security（安全，通用准则，所有 SOC 2 必备）

| 控制                     | 状态 | 证据                                                                                              |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------- |
| 传输加密(TLS/HSTS)       | ✅   | `next.config.ts` headers: HSTS/CSP/X-Frame-Options/X-Content-Type                                 |
| 静态敏感数据加密         | ✅   | 交易所 API key/secret AES-256-GCM(`lib/exchange/secure-encryption.ts`)                            |
| 密钥管理                 | ✅   | 无硬编码密钥(grep 全量验证)；zod env 校验 fail-fast(`lib/env.ts`)；密钥在 Vercel/GH secrets       |
| 鉴权                     | ✅   | Supabase Auth + Privy Web3；timing-safe 服务鉴权(`crypto.timingSafeEqual`)                        |
| 授权(最小权限)           | ✅   | 全表 RLS；`user_profiles` 列级 REVOKE + SECURITY DEFINER RPC 取 PII                               |
| API 鉴权覆盖             | ✅   | `qa:api-auth` CI 门禁：每 route 有 auth 原语或登记公开白名单(2026-07-02)                          |
| 限流/防滥用              | ✅   | 236/321 route 限流，区分 fail-close/open(`lib/utils/rate-limit.ts`)                               |
| 支付完整性               | ✅   | Stripe webhook 签名校验 + 原子幂等(unique 约束 23505)                                             |
| 漏洞管理                 | ✅   | dependabot 每周 + `npm audit` CI 阻断(high/critical) + SECURITY.md 书面评估                       |
| 变更管理                 | 🟡   | CI/Deploy Gate 与 managed hooks 已启用；branch ruleset 受当前 GitHub 套餐限制，尚不能证明平台强制 |
| 访问审计日志             | ✅   | admin 操作 `[ADMIN-AUDIT]` 日志 + `/api/admin/audit-logs`                                         |
| CSRF/CORS                | ✅   | `lib/api/csrf.ts` + `lib/utils/cors.ts`                                                           |
| 代码 review              | 🟡   | CODEOWNERS 与 PR 流程已立；code-owner review 尚未由平台强制（见 RELEASE.md）                      |
| 分支保护 required checks | 🟡   | CI contexts 存在；private-repo rulesets API 返回套餐 403，当前 enforcement 不可证明               |

## A — Availability（可用性）

| 控制                  | 状态 | 证据                                                                                               |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| SLO 定义              | ✅   | `docs/SLO.md` 5 条(核心页/API/数据新鲜度/备份/写路径)                                              |
| 健康监控              | 🟡   | 端点/workflow/告警契约已立；GitHub 缺 CRON_SECRET，当前探测 fail-closed，且生产 freshness degraded |
| 部署后验证 + 自动回滚 | ✅   | deploy-gate smoke + 失败自动 promote 回滚(2026-07-02)                                              |
| 备份                  | 🔴   | artifact/HEAD/新鲜度契约已立；GitHub 连接与 R2 写凭据不完整，连续失败且 auth 独立副本尚缺          |
| 灾难恢复              | 🔴   | managed scratch 全恢复未通过；当前只能依赖 Supabase PITR（SLO #4）                                 |
| 冗余/失败切换         | 🟡   | worker 双节点 + 心跳漂移哨兵；但 Mac Mini/VPS 单点仍在(→ PHASE2_INFRA_PLAN #2)                     |
| 事故响应              | ✅   | 高质量 RUNBOOK + postmortem 制度(模板 + 5 起回填)                                                  |
| 弹性(重试/熔断)       | ✅   | 自有 circuit breaker + 重试 + 分布式锁 + BullMQ 3x                                                 |

## C — Confidentiality（保密）

| 控制              | 状态 | 证据                                      |
| ----------------- | ---- | ----------------------------------------- |
| 数据分级/最小暴露 | ✅   | RLS 列级 PII 保护；公开只读端点显式白名单 |
| 凭据保密          | ✅   | 交易所凭据 AES-256-GCM；无硬编码密钥      |
| 传输保密          | ✅   | 全站 HTTPS(HTTP→HTTPS 升级)               |

## PI — Processing Integrity（处理完整性）

| 控制         | 状态 | 证据                                                                                |
| ------------ | ---- | ----------------------------------------------------------------------------------- |
| 数据质量守卫 | ✅   | `lib/validation/data-write-gate.ts`（发布写入前拦截越界指标）                       |
| schema 契约  | ✅   | `qa:schema` CI 门禁(代码 DB 依赖 vs 生产) + 每日金丝雀哨兵                          |
| 迁移一致性   | 🟡   | ADR-023 单文件生产通道；历史仍有 252 remote-only/34 local-only，fresh replay 未恢复 |
| 幂等         | ✅   | Stripe idempotencyKey；写路径原子 RPC(non-trigger counters)                         |
| 输入校验     | 🟡   | zod 广泛用(`lib/api/validation.ts`)但非 100% route 覆盖                             |
| 类型安全     | ✅   | tsc strict + CI 全量检查、pre-commit staged lint；无类型错误豁免文件                |

## P — Privacy（隐私）

| 控制             | 状态 | 证据                                                                          |
| ---------------- | ---- | ----------------------------------------------------------------------------- |
| 隐私政策/ToS     | ✅   | `app/(app)/(legal)/`：privacy/terms/disclaimer/dmca                           |
| 数据可携带(导出) | ✅   | `/api/settings/export`(GDPR 可携带权)                                         |
| 删除权           | ✅   | `/api/account/delete` 软删除 30 天宽限 + 关联物理删除 + 匿名化 + cleanup cron |
| 同意/恢复        | ✅   | `/api/account/recover`；账号删除可恢复                                        |
| PII 最小化       | ✅   | 列级 REVOKE + SECURITY DEFINER 取自身 PII                                     |

## 缺口汇总（→ 指向已有计划）

1. 轮换并恢复 GitHub health/backup secrets，取得新的 authenticated monitor 与 R2 HEAD/freshness 成功证据（`docs/SLO.md`）
2. 升级支持 rulesets 的 GitHub 套餐后，机读应用并证明 code-owner review、required checks 与零 bypass（`docs/RELEASE.md`）
3. auth sidecar + canonical baseline + managed scratch 首次恢复验收，此后季度复演 —— `docs/SLO.md` #4
4. 基础设施单点冗余 —— `docs/PHASE2_INFRA_PLAN.md` #2(要钱)
5. 标准可观测性栈(时序 metrics/dashboard) —— `docs/PHASE2_INFRA_PLAN.md` #1(要钱)
6. 输入校验 100% route 覆盖 —— 增量收敛

## 定性

此表是内部差距映射，不是 SOC 2 认证或生产验收证据。发布前仍需关闭 auth 独立
备份与 managed scratch 恢复、branch ruleset 强制、migration fresh replay、基础设施冗余/观测和正式审计取证
等缺口；任何一项都不能由“代码存在”替代实际演练证据。
即:控制**能力**已具备，差的是**制度强制**与**第三方取证**——与整份差距报告结论一致。
