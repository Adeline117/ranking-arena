# Supabase 数据库迁移

本目录包含数据库迁移文件，用于版本控制数据库架构变更。

## 目录结构

```
supabase/
├── config.toml          # Supabase CLI 配置
├── migrations/          # 迁移文件目录
│   └── YYYYMMDDHHMMSS_*.sql
└── README.md
```

## 使用方法

### 1. 安装 Supabase CLI

```bash
npm install -g supabase
# 或
brew install supabase/tap/supabase
```

### 2. 本地开发

```bash
# 启动本地 Supabase 实例
supabase start

# 查看本地服务状态
supabase status

# 停止本地服务
supabase stop
```

### 3. 迁移管理

```bash
# 创建新迁移
scripts/new-migration.sh <migration_name>

# 只读查看历史差异（不得随后执行 db push）
supabase db push --dry-run
```

> **生产禁区（2026-07-17）**：最新 dry-run 显示 `252 remote-only + 34
local-only`。生产 schema 的 live contract 健康，但历史迁移链不能从空库
> fresh replay。禁止对生产执行裸 `supabase db push`、`--include-all` 或
> `supabase migration repair --status reverted`；`supabase db reset` 也不能作为
> 当前全历史可重放证明。

### 4. 生成类型定义

```bash
# 从经过项目/PostgREST 身份证明的生产 schema 生成 canonical 类型
npm run gen:types

# CI 同款只读漂移检查
npm run gen:types:check
```

不要直接重定向全局或 `latest` CLI 的输出；仓库脚本固定 CLI 版本、生产
`DATABASE_URL` 来源、REST attestation、AST 语义覆盖和 canonical 输出路径。

## 迁移文件命名规范

迁移文件按以下格式命名：

`YYYYMMDDHHMMSS_description.sql`

- `YYYYMMDDHHMMSS`: 14 位 UTC 时间戳
- `description`: 简短描述，使用下划线分隔

示例：

- `20260717120000_add_trader_stats_index.sql`

## 编写迁移注意事项

1. **幂等性**: 迁移应该可以安全地重复执行

   ```sql
   CREATE TABLE IF NOT EXISTS ...
   CREATE INDEX IF NOT EXISTS ...
   ```

2. **回滚**: 生产回滚使用新的前向补偿迁移；灾难场景才选择 PITR，不修改 ledger

3. **数据迁移**: 如果涉及数据迁移，先备份

4. **RLS 策略**: 新表必须启用 RLS 并添加策略

## 环境变量

类型生成脚本要求以下环境变量（仅放在本地 secret store/CI secrets）：

```bash
DATABASE_URL=<production database URL>
SUPABASE_URL=<https://project-ref.supabase.co>
SUPABASE_SECRET_KEY=<server-side secret key>
```

## 生产部署

生产 schema 写入必须串行，只能通过 Supabase MCP `apply_migration` 应用**一个**
已审查文件，migration name 使用该文件的 description。应用后核对精确 ledger
记录、live object definition/privileges，并运行 `npm run qa:schema`；MCP
不可用时暂停发布。

恢复 fresh replay 能力属于独立的 canonical-baseline 维护波次，必须先在空白
PG17/shadow 项目验证；不要在日常功能迁移或生产事故中临时对账历史。
