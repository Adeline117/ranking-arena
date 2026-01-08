# 注册流程配置说明

## 注册流程概述

Ranking Arena 使用邮箱验证码注册流程，具体步骤如下：

1. **填写邮箱** - 用户输入邮箱地址
2. **发送验证码** - 系统发送6位数字验证码到邮箱（10分钟有效）
3. **验证验证码** - 用户输入验证码进行验证
4. **设置密码和用户名** - 验证成功后设置密码和用户名
5. **完成注册** - 系统自动生成唯一的用户ID

## 重要特性

### 用户名规则
- ✅ **用户名可以重复** - 多个用户可以使用相同的用户名
- ✅ **用户ID唯一** - 由 Supabase 自动生成 UUID，保证唯一性
- ✅ **最小长度** - 用户名至少3个字符
- ✅ **无唯一性检查** - 系统不会检查用户名是否已被使用

### 验证码规则
- ✅ **有效期** - 验证码10分钟内有效
- ✅ **重发限制** - 60秒内不能重复发送
- ✅ **自动过期** - 超过10分钟未使用，验证码自动失效

## Supabase 配置

### 1. 移除用户名唯一性约束

在 Supabase Dashboard 的 SQL Editor 中运行：

```sql
-- 运行 scripts/remove_handle_unique_constraint.sql
```

这个脚本会：
- 移除 `user_profiles` 表中 `handle` 字段的唯一性约束
- 移除相关的唯一索引
- 创建普通索引以提高查询性能

### 2. 配置验证码有效期

Supabase 默认的 OTP 验证码有效期是 1 小时。要设置为 10 分钟，需要在 Supabase Dashboard 中配置：

1. 进入 **Authentication** → **Settings**
2. 找到 **Email Auth** 部分
3. 设置 **OTP expiry** 为 `600` 秒（10分钟）
4. 保存设置

或者通过环境变量配置（如果支持）：

```bash
SUPABASE_AUTH_OTP_EXPIRY=600
```

### 3. 邮箱配置

确保 Supabase 的邮箱服务已正确配置：

1. 进入 **Authentication** → **Settings**
2. 确保 **Enable Email provider** 已启用
3. 配置邮箱模板（可选）
4. 设置 **Site URL** 和 **Redirect URLs**

## 数据库结构

### user_profiles 表

```sql
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT,  -- 用户名，可以重复
  email TEXT,
  bio TEXT,
  avatar_url TEXT,
  market_pairs JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 普通索引（非唯一）
CREATE INDEX idx_user_profiles_handle ON user_profiles(handle);
```

**注意**：
- `id` 字段是主键，引用 `auth.users(id)`，由 Supabase 自动生成
- `handle` 字段没有唯一性约束，允许多个用户使用相同的用户名
- 通过 `id` 字段区分不同的用户，而不是 `handle`

## 测试注册流程

### 1. 测试用户名重复

1. 使用邮箱 `user1@example.com` 注册，用户名设置为 `testuser`
2. 使用邮箱 `user2@example.com` 注册，用户名也设置为 `testuser`
3. 两个用户应该都能成功注册，使用相同的用户名

### 2. 测试验证码过期

1. 发送验证码
2. 等待超过10分钟
3. 尝试使用验证码验证
4. 应该提示验证码已过期

### 3. 测试验证码重发

1. 发送验证码
2. 在60秒内尝试再次发送
3. 应该显示倒计时，无法重发
4. 等待60秒后，可以重新发送

## 常见问题

### Q: 如果多个用户使用相同的用户名，如何区分？

A: 系统通过用户ID（UUID）区分用户，而不是用户名。每个用户的 `id` 字段都是唯一的，由 Supabase 自动生成。

### Q: 验证码有效期可以调整吗？

A: 可以，在 Supabase Dashboard 的 Authentication Settings 中配置 OTP expiry 时间。

### Q: 用户名重复会影响功能吗？

A: 不会。所有功能都基于用户ID（`id`）而不是用户名（`handle`）。用户名仅用于显示和URL路由。

### Q: 如何查询特定用户名的所有用户？

A: 使用以下 SQL 查询：

```sql
SELECT * FROM user_profiles WHERE handle = 'username';
```

这会返回所有使用该用户名的用户。

## 相关文档

- [登录流程说明](./LOGIN_FLOW.md) - 完整的登录/注册流程
- [Supabase 设置指南](./SUPABASE_SETUP.md) - Supabase 基础配置


