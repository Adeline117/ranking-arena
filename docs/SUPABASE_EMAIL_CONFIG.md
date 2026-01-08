# Supabase 邮箱配置详细步骤

## 步骤 1: 在 Supabase Dashboard 中配置邮箱

### 1.1 访问 Supabase Dashboard
1. 打开 https://supabase.com/dashboard
2. 登录你的账号
3. 选择你的项目

### 1.2 配置 Authentication 设置
1. 在左侧菜单中，点击 **Authentication**
2. 点击 **Settings** 标签
3. 找到 **Email Auth** 部分

### 1.3 配置邮箱验证设置
在 **Email Auth** 部分，配置以下选项：

- **Enable email confirmations**: 
  - ✅ **关闭**（OTP 注册不需要邮箱确认）
  - 如果启用，用户需要点击邮件中的链接才能注册

- **Enable email change confirmations**: 
  - ✅ **关闭**（可选）

- **Secure email change**: 
  - ✅ **关闭**（可选）

### 1.4 配置 OTP 设置
1. 在 **Authentication** → **Settings** 中
2. 找到 **Auth Providers** 部分
3. 点击 **Email** provider
4. 确保以下设置：
   - ✅ **Enable Email provider**: 已启用
   - **OTP expiry**: `3600` (1小时，默认值)
   - **OTP length**: `6` (默认值)

### 1.5 配置邮箱模板（可选）
1. 在 **Authentication** → **Email Templates** 中
2. 可以自定义以下模板：
   - **Magic Link**: 用于 OTP 验证码
   - **Change Email Address**: 更改邮箱
   - **Reset Password**: 重置密码
3. 默认模板已经包含验证码，可以直接使用

## 步骤 2: 运行数据库配置脚本

### 2.1 在 Supabase Dashboard 中运行 SQL
1. 在左侧菜单中，点击 **SQL Editor**
2. 点击 **New query**
3. 打开 `scripts/setup_supabase_tables.sql` 文件
4. 复制全部内容到 SQL Editor
5. 点击 **Run** 执行

### 2.2 验证表结构
运行以下查询验证表是否创建成功：

```sql
-- 检查 profiles 表
SELECT * FROM profiles LIMIT 1;

-- 检查 posts 表结构
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'posts' 
AND column_name IN ('author_id', 'author_handle');
```

## 步骤 3: 配置 Storage（头像上传）

### 3.1 创建 avatars bucket
1. 在左侧菜单中，点击 **Storage**
2. 点击 **New bucket**
3. 设置：
   - **Name**: `avatars`
   - **Public bucket**: ✅ **启用**（头像需要公开访问）
   - **File size limit**: `5242880` (5MB)
   - **Allowed MIME types**: `image/*`
4. 点击 **Create bucket**

### 3.2 设置 Storage RLS 策略
在 **SQL Editor** 中运行：

```sql
-- 策略：所有人可以读取 avatars
CREATE POLICY "Avatar images are publicly accessible"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- 策略：已登录用户可以上传自己的头像
CREATE POLICY "Users can upload their own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars' AND
    auth.role() = 'authenticated'
  );

-- 策略：用户可以更新自己的头像
CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars' AND
    auth.role() = 'authenticated'
  );

-- 策略：用户可以删除自己的头像
CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars' AND
    auth.role() = 'authenticated'
  );
```

## 步骤 4: 测试功能

### 4.1 测试注册（验证码方式）
1. 访问 `http://localhost:3000/login`（或你的部署地址）
2. 点击"还没有账号？使用验证码注册"
3. 输入你的真实邮箱地址
4. 点击"发送验证码"
5. 检查邮箱中的验证码（6位数字）
6. 输入验证码并点击"验证并注册"
7. 设置密码（至少6位）
8. 完成注册

### 4.2 测试登录
1. 使用刚才注册的邮箱和密码登录
2. 确认登录成功并跳转到首页

### 4.3 测试发帖
1. 登录后，访问任意小组页面，例如 `/groups/[group_id]/new`
2. 如果没有小组，先创建一个测试小组：
   ```sql
   INSERT INTO groups (id, name, subtitle) 
   VALUES ('test-group-1', '测试小组', '这是一个测试小组')
   ON CONFLICT (id) DO NOTHING;
   ```
3. 填写标题和内容
4. 点击"发布"
5. 确认帖子已创建并显示在小组页面

### 4.4 测试个人信息编辑
1. 访问 `/settings`
2. 编辑以下信息：
   - Handle（用户名）
   - Bio（个人简介）
   - 头像（上传图片）
3. 点击"保存"
4. 确认信息已更新

## 步骤 5: 验证数据

### 5.1 检查用户 profile
在 SQL Editor 中运行：

```sql
-- 查看所有 profiles
SELECT id, handle, email, created_at 
FROM profiles 
ORDER BY created_at DESC 
LIMIT 10;
```

### 5.2 检查帖子数据
```sql
-- 查看所有帖子及其作者
SELECT 
  p.id,
  p.title,
  p.author_handle,
  p.author_id,
  p.created_at,
  pr.handle as profile_handle
FROM posts p
LEFT JOIN profiles pr ON p.author_id = pr.id
ORDER BY p.created_at DESC
LIMIT 10;
```

## 常见问题

### Q1: 收不到验证码邮件
- 检查邮箱的垃圾邮件文件夹
- 确认 Supabase 的邮箱服务已启用
- 检查邮箱地址是否正确
- 如果是开发环境，验证码可能在 Supabase Dashboard 的日志中

### Q2: 注册后 profile 未创建
- 检查触发器是否已创建（运行 `setup_supabase_tables.sql`）
- 手动创建 profile：
  ```sql
  INSERT INTO profiles (id, email, handle)
  SELECT id, email, split_part(email, '@', 1)
  FROM auth.users
  WHERE id NOT IN (SELECT id FROM profiles);
  ```

### Q3: 发帖失败，提示权限错误
- 检查 posts 表的 RLS 策略是否正确
- 确认用户已登录（`auth.role() = 'authenticated'`）
- 检查 `author_id` 字段是否正确设置

### Q4: 无法上传头像
- 检查 `avatars` bucket 是否已创建
- 检查 Storage RLS 策略是否正确
- 确认 bucket 是公开的（Public bucket）

## 完成！

配置完成后，你的系统应该支持：
- ✅ 邮箱验证码注册
- ✅ 密码注册
- ✅ 邮箱密码登录
- ✅ 发帖（关联真实用户）
- ✅ 个人信息编辑
- ✅ 头像上传



