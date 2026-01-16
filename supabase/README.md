# Supabase 数据库迁移

本目录包含数据库迁移文件，用于版本控制数据库架构变更。

## 目录结构

```
supabase/
├── config.toml          # Supabase CLI 配置
├── migrations/          # 迁移文件目录
│   └── 00001_*.sql     # 按顺序编号的迁移文件
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
supabase migration new <migration_name>

# 应用迁移到本地数据库
supabase db reset

# 推送迁移到远程数据库
supabase db push

# 查看迁移状态
supabase migration list
```

### 4. 生成类型定义

```bash
# 生成 TypeScript 类型
supabase gen types typescript --local > lib/types/database.ts
```

## 迁移文件命名规范

迁移文件按以下格式命名：

```
NNNNN_description.sql
```

- `NNNNN`: 5位数字序号，从 00001 开始
- `description`: 简短描述，使用下划线分隔

示例：
- `00001_initial_schema.sql`
- `00002_add_bookmarks_table.sql`
- `00003_add_user_settings.sql`

## 编写迁移注意事项

1. **幂等性**: 迁移应该可以安全地重复执行
   ```sql
   CREATE TABLE IF NOT EXISTS ...
   CREATE INDEX IF NOT EXISTS ...
   ```

2. **回滚**: 复杂迁移应包含回滚语句（注释形式）
   ```sql
   -- 回滚: DROP TABLE IF EXISTS new_table;
   ```

3. **数据迁移**: 如果涉及数据迁移，先备份

4. **RLS 策略**: 新表必须启用 RLS 并添加策略

## 环境变量

确保设置以下环境变量：

```bash
SUPABASE_ACCESS_TOKEN=<your-access-token>
SUPABASE_PROJECT_ID=<your-project-id>
```

## 生产部署

1. 在 PR 中预览迁移变更
2. 合并后自动应用到 staging
3. 手动批准后应用到 production

```bash
# 链接到远程项目
supabase link --project-ref <project-id>

# 推送到远程
supabase db push
```
