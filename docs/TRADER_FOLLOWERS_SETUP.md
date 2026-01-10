# Trader 粉丝数设置说明

## 概述

所有 trader 的粉丝数只能来源 Arena 注册用户的关注，不再使用从交易所 API 获取的 followers 数据。

## 数据库设置

### 1. 运行 SQL 脚本

在 Supabase Dashboard 的 SQL Editor 中运行以下脚本：

```bash
scripts/setup_trader_follows.sql
```

此脚本将：
- 创建 `trader_follows` 表
- 创建必要的索引
- 设置 RLS 策略
- 创建统计函数和视图
- 如果已存在 `follows` 表，会迁移数据到 `trader_follows` 表

### 2. 验证表结构

运行以下查询验证表是否创建成功：

```sql
SELECT * FROM trader_follows LIMIT 5;
SELECT * FROM trader_arena_followers_count LIMIT 5;
```

## 功能说明

### 粉丝数统计

- **数据来源**：`trader_follows` 表
- **统计方式**：通过 `COUNT(*)` 统计每个 `trader_id` 的关注关系
- **实时性**：每次查询时实时统计，确保数据准确

### 关注功能

- **关注操作**：用户点击"关注"按钮时，会在 `trader_follows` 表中插入一条记录
- **取消关注**：用户点击"已关注"按钮时，会从 `trader_follows` 表中删除对应记录
- **唯一约束**：确保一个用户只能关注一个 trader 一次（通过 `UNIQUE(user_id, trader_id)` 约束）

## 代码实现

### 获取粉丝数

```typescript
import { getTraderArenaFollowersCount, getTradersArenaFollowersCount } from '@/lib/data/trader-followers'

// 获取单个 trader 的粉丝数
const count = await getTraderArenaFollowersCount(supabase, traderId)

// 批量获取多个 trader 的粉丝数
const countsMap = await getTradersArenaFollowersCount(supabase, traderIds)
```

### 关注/取消关注

```tsx
import FollowButton from '@/app/components/UI/FollowButton'

<FollowButton 
  traderId={traderId} 
  userId={userId} 
  initialFollowing={false} 
/>
```

## 数据迁移

### 从旧系统迁移（如果适用）

如果之前使用的是 `follows` 表，运行 `setup_trader_follows.sql` 脚本会自动迁移数据。

### 导入脚本更新

所有导入脚本（`import_*.mjs`）已更新：
- 不再从交易所 API 获取 `followers` 数据
- `snapshotsData` 不再包含 `followers` 字段
- 如果数据库表中有 `followers` 列且不允许 NULL，可以设置为 0，但代码中不再使用此值

## 注意事项

1. **数据一致性**：所有粉丝数都从 `trader_follows` 表统计，确保数据一致性
2. **性能优化**：批量获取粉丝数时会分批查询，避免单次查询过多
3. **向后兼容**：数据库中的 `followers` 列仍然保留（如果存在），但代码中不再使用此值
4. **RLS 策略**：`trader_follows` 表已启用 RLS，确保数据安全

## 测试

### 测试关注功能

1. 登录 Arena 账号
2. 访问 trader 详情页
3. 点击"关注"按钮
4. 验证粉丝数是否增加
5. 点击"已关注"按钮取消关注
6. 验证粉丝数是否减少

### 测试粉丝数统计

1. 让多个用户关注同一个 trader
2. 验证该 trader 的粉丝数是否正确显示
3. 取消关注后验证粉丝数是否正确减少

## 故障排查

### 粉丝数显示为 0

- 检查 `trader_follows` 表是否存在
- 检查 RLS 策略是否正确设置
- 检查 `trader_id` 是否正确匹配

### 关注按钮不工作

- 检查用户是否已登录
- 检查 `trader_follows` 表的 INSERT/DELETE 权限
- 检查浏览器控制台是否有错误信息

