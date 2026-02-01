# 交易员头像修复指南

## 问题描述

交易员头像无法显示的原因：
1. `trader_sources` 表缺少 `avatar_url` 字段
2. API代码错误地使用 `profile_url`（交易员主页URL）作为头像URL
3. `profile_url` 不是图片URL，被 `getTraderAvatarUrl` 函数过滤掉

## 修复步骤

### 1. 运行数据库迁移

在 Supabase SQL Editor 中运行以下迁移：

```bash
# 迁移文件位置
supabase/migrations/00031_add_avatar_url_to_trader_sources.sql
```

这将在 `trader_sources` 表添加 `avatar_url` 列。

### 2. 抓取头像数据

运行以下脚本填充头像数据：

```bash
# 抓取所有平台的头像
node scripts/fetch-platform-avatars.mjs --source=all

# 只抓取特定平台
node scripts/fetch-platform-avatars.mjs --source=xt
node scripts/fetch-platform-avatars.mjs --source=lbank

# 测试运行（不实际更新数据库）
node scripts/fetch-platform-avatars.mjs --source=all --dry-run
```

### 3. 部署代码更新

已修改的文件：
- `app/api/traders/route.ts` - 主排行榜API
- `app/api/following/route.ts` - 关注列表API
- `supabase/migrations/00031_add_avatar_url_to_trader_sources.sql` - 数据库迁移

提交并部署代码后，头像将正常显示。

## 字段说明

- **`avatar_url`**: 交易员头像图片URL（直接图片链接）
- **`profile_url`**: 交易员主页URL（网页链接）

## 验证

部署后，检查：
1. 排行榜页面交易员头像是否显示
2. 交易员详情页头像是否显示
3. 关注列表中交易员头像是否显示

如果头像仍未显示，检查：
- 浏览器控制台是否有图片加载错误
- `/api/avatar?url=...` 代理端点是否正常工作
- 数据库中 `avatar_url` 字段是否有数据

## 数据库查询示例

检查有多少交易员有头像：

```sql
-- 有头像的交易员数量
SELECT source, COUNT(*)
FROM trader_sources
WHERE avatar_url IS NOT NULL
GROUP BY source;

-- 没有头像的交易员
SELECT source, COUNT(*)
FROM trader_sources
WHERE avatar_url IS NULL
GROUP BY source;
```
