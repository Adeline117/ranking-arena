# Supabase 配置指南

## 1. 邮箱验证码（OTP）配置

### 在 Supabase Dashboard 中配置：

1. **登录 Supabase Dashboard**
   - 访问 https://supabase.com/dashboard
   - 选择你的项目

2. **配置 Authentication 设置**
   - 进入 `Authentication` → `Settings`
   - 找到 `Email Auth` 部分
   - 确保以下设置：
     - ✅ Enable email confirmations: **关闭**（OTP 不需要邮箱确认）
     - ✅ Enable email change confirmations: **关闭**
     - ✅ Enable phone confirmations: **关闭**（如果不需要）

3. **配置 OTP 设置**
   - 在 `Authentication` → `Settings` → `Auth Providers`
   - 找到 `Email` provider
   - 确保 `Enable Email provider` 已启用
   - OTP 设置：
     - OTP expiry: `3600` (1小时，默认值)
     - OTP length: `6` (默认值)

4. **配置邮箱模板（可选）**
   - 进入 `Authentication` → `Email Templates`
   - 可以自定义验证码邮件模板
   - 默认模板已经包含验证码

## 2. 数据库表结构

### 确保以下表存在并包含必要字段：

```sql
-- 1. profiles 表（用户资料）
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. user_profiles 表（备用，如果 profiles 不存在）
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  email TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. posts 表（确保包含 author_id 和 author_handle）
-- 如果 posts 表已存在，只需要添加字段：
ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_handle TEXT;

-- 4. 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_profiles_handle ON profiles(handle);
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_author_handle ON posts(author_handle);
```

## 3. Row Level Security (RLS) 策略

### 为 profiles 表设置 RLS：

```sql
-- 启用 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 策略：所有人可以读取 profiles
CREATE POLICY "Profiles are viewable by everyone"
  ON profiles FOR SELECT
  USING (true);

-- 策略：用户可以插入自己的 profile
CREATE POLICY "Users can insert their own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- 策略：用户可以更新自己的 profile
CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- 策略：用户可以删除自己的 profile
CREATE POLICY "Users can delete their own profile"
  ON profiles FOR DELETE
  USING (auth.uid() = id);
```

### 为 posts 表设置 RLS：

```sql
-- 启用 RLS
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- 策略：所有人可以读取 posts
CREATE POLICY "Posts are viewable by everyone"
  ON posts FOR SELECT
  USING (true);

-- 策略：已登录用户可以创建 posts
CREATE POLICY "Authenticated users can create posts"
  ON posts FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- 策略：用户可以更新自己的 posts
CREATE POLICY "Users can update their own posts"
  ON posts FOR UPDATE
  USING (auth.uid() = author_id);

-- 策略：用户可以删除自己的 posts
CREATE POLICY "Users can delete their own posts"
  ON posts FOR DELETE
  USING (auth.uid() = author_id);
```

## 4. 触发器：自动创建 profile

### 创建触发器，在用户注册时自动创建 profile：

```sql
-- 函数：创建用户 profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, handle)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'handle', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 触发器：在用户注册时自动创建 profile
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
```

## 5. Storage 配置（头像上传）

### 创建 avatars bucket：

1. 进入 `Storage` → `Buckets`
2. 点击 `New bucket`
3. 设置：
   - Name: `avatars`
   - Public bucket: ✅ **启用**（头像需要公开访问）
   - File size limit: `5242880` (5MB)
   - Allowed MIME types: `image/*`

### 设置 Storage RLS 策略：

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
    auth.role() = 'authenticated' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- 策略：用户可以更新自己的头像
CREATE POLICY "Users can update their own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars' AND
    auth.role() = 'authenticated' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- 策略：用户可以删除自己的头像
CREATE POLICY "Users can delete their own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars' AND
    auth.role() = 'authenticated' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );
```

## 6. 环境变量检查

确保以下环境变量已设置：

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

## 7. 测试步骤

1. **测试注册**：
   - 访问 `/login`
   - 选择"使用验证码注册"
   - 输入邮箱，点击"发送验证码"
   - 检查邮箱中的验证码
   - 输入验证码并验证
   - 设置密码

2. **测试登录**：
   - 使用邮箱和密码登录
   - 确认登录成功

3. **测试发帖**：
   - 登录后访问 `/groups/[group_id]/new`
   - 填写标题和内容
   - 点击"发布"
   - 确认帖子已创建并关联到当前用户

4. **测试个人信息编辑**：
   - 访问 `/settings`
   - 编辑 handle、bio、头像
   - 保存并确认更新成功





