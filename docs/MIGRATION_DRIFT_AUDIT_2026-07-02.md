# 迁移漂移审计与对账（2026-07-02）✅ 已完成

> **历史快照，操作结论已被 ADR-023 supersede（2026-07-16）。** 当日补记曾让
> `db push` no-op，但后续换名/远端-only 版本再次累积；当前实测 `db push --dry-run`
> 会因历史不可对应而拒绝。不要按本文旧结论裸跑 `db push`，也不要执行 CLI 建议的
> `migration repair --status reverted`。现行单文件流程见 `CLAUDE.md` 与 ADR-023。

> 差距报告 #5 的专项。审计 + 对账**均已执行完成**。
> 生产项目 = `iknktzifjdyujdccyhsv`（us-west-2）。
>
> **结果**：ledger 186→504（补记 317 + 并发 1）；全量验证 377 个仓库版本
> **全部在 ledger**（`repo_versions_missing_from_ledger=0`），`supabase db push`
> 已变 no-op，SEV1 footgun 消除。全程零 DDL，生产 schema 未被触碰，qa:schema 保持绿。
> 可逆凭据：`DELETE ... WHERE created_by='ledger-reconcile-20260702'`。

## 一、结论先行（好消息）

**运行系统零风险。** `npm run qa:schema` 实时通过：代码依赖的 73 个 RPC + 127 张表
在生产（200 函数 / 167 表）**全部存在**。漂移**不影响任何在跑的功能**——2026-06
那次"社交/支付静默 500"的根因（代码引用了生产不存在的对象）**早已被修复**，现在
代码的每一个 DB 依赖都落地了。

漂移的本质是**记账错位**（文件名 ↔ ledger version 对不上），而非"schema 缺失"。
唯一残留的**潜在**危险：`supabase db push` 会把 317 个"ledger 里没有"的仓库文件
当成待应用去跑。而 push **只在文档里**（`new-migration.sh` 指引），**无任何 CI 或
自动化脚本调用它**——所以这是一个人工 footgun，不是自动灾难。

## 二、三方 diff（精确数字）

| 集合                     | 数量    | 说明                                              |
| ------------------------ | ------- | ------------------------------------------------- |
| 仓库迁移文件             | 377     | `supabase/migrations/*.sql`                       |
| 生产 ledger 版本         | 186     | `supabase_migrations.schema_migrations`           |
| **A. 仓库有、ledger 无** | **317** | push 会误当待应用（261 个 baseline 前 + 56 个后） |
| **B. ledger 有、仓库无** | **126** | 文件被改名/删除的历史应用，push 忽略，无害        |

### 抽样验证（证明"记账错位"而非"schema 缺失"）

| 迁移                      | 对象                    | 生产状态   | 判定                                    |
| ------------------------- | ----------------------- | ---------- | --------------------------------------- |
| `20260615204949`          | DROP trader_latest/v2   | 已 DROP ✓  | 已应用，只是没记账                      |
| `00059_flash_news`        | flash_news 表           | 存在 ✓     | 已应用，只是没记账                      |
| `00058_user_weight`       | user weight 列          | 存在 ✓     | 已应用，只是没记账                      |
| `00057_library_lang_sort` | library_items_by_lang() | **不存在** | 真未应用，但**代码零引用=死迁移**，无害 |

结论：317 个 repo-only 里，绝大多数**效果已在生产**（记账错位），少数（如 00057）
**真没应用但是死代码**（qa:schema 绿证明：任何被引用的对象都已存在）。

## 三、对账方案（三选一，按推荐度）

### 方案 1（推荐）：ledger 补记 —— 让 push 变 no-op

把 317 个 repo-only 版本标记为"已应用"（纯记账 INSERT，不跑任何 DDL）。
之后 `supabase db push` 看到全部已应用 → no-op → footgun 消除。

- **风险**：极低（additive，不改现有行，不动 schema/数据，可逆）
- **可逆**：所有补记行带 `created_by='ledger-reconcile-20260702'`，一条 DELETE 撤销
- **标准工具等价**：`supabase migration repair --status applied <version>`（逐个）
- **执行**：见下方「执行步骤」。**这是需要你确认的生产写操作**。

### 方案 2：squash 到单一 baseline

从生产 dump schema 作为唯一 baseline 迁移，归档 377 个历史文件，ledger 重置到
baseline。最干净（377→1）但**ledger 重置是更大的生产写**，且 baseline dump 若漏
grant/policy，未来新环境重建会缺——风险高于方案 1，不建议现在做。

### 方案 3：现状 + guard（什么都不写生产）

保留现有 `check-migration-ledger.mjs` 的 BASELINE 机制 + 加一个 pre-push/文档 guard
警示"别裸跑 db push"。不解决漂移，只是继续 guard——不符合"根治"目标。

## 四、方案 1 执行步骤（待你确认）

对账 SQL 已生成为可复核产物：`scripts/migration-reconcile/ledger-repair-20260702.sql`
（INSERT ... ON CONFLICT (version) DO NOTHING，317 行，带可逆标记；**故意放在
migrations 目录外**，避免被 push 当迁移误读）。

```bash
# 1. 复核产物内容（纯 INSERT，无 DDL）
less scripts/migration-reconcile/ledger-repair-20260702.sql

# 2. 执行（二选一）
#    a) 经 Supabase MCP execute_sql（单一会话，串行）
#    b) 或 psql "$DATABASE_URL" -f scripts/migration-reconcile/ledger-repair-20260702.sql

# 3. 验证：仓库所有版本 ⊆ ledger（push 应为 no-op）
node scripts/qa/check-migration-ledger.mjs

# 回滚（若需要）：
# DELETE FROM supabase_migrations.schema_migrations WHERE created_by='ledger-reconcile-20260702';
```

**执行纪律**（CLAUDE.md 铁律）：schema 单一通道——同一时刻只有一个会话动 ledger，
执行前确认无其他会话正在 apply 迁移。

## 五、后续（可选，非紧急）

- 补记后可选做方案 2 的 squash 清理 377 文件杂乱（择日、有 shadow DB 验证时）
- `check-migration-ledger.mjs` 的 BASELINE 可在补记后前移/取消（届时全量可核对）
