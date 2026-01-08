# Supabase OTP 验证码配置修复指南

## 问题描述

如果注册时收到的是 Magic Link（链接）而不是 OTP 验证码（6位数字），需要检查以下配置。

## 解决方案

### 1. 检查 Supabase Dashboard 配置

#### 步骤 1：检查 Email Auth 设置

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目
3. 进入 **Authentication** → **Settings**
4. 找到 **Auth Providers** → **Email** 部分
5. 确保以下设置：

   - ✅ **Enable Email provider**: 已启用
   - ✅ **Confirm email**: **关闭**（OTP 不需要邮箱确认）
   - ✅ **Secure email change**: 关闭（可选）

#### 步骤 2：检查 URL 配置

1. 在 **Authentication** → **Settings** → **URL Configuration** 中
2. 设置 **Site URL** 为：`https://www.arenafi.org`
3. 在 **Redirect URLs** 中添加：
   - `https://www.arenafi.org/login`
   - `https://www.arenafi.org/**`（如果需要）
   - `http://localhost:3000/login`（仅开发环境）

**重要**：确保 Site URL 设置为生产域名，而不是 localhost。

#### 步骤 3：检查 Email Templates

1. 进入 **Authentication** → **Email Templates**
2. 找到 **Magic Link** 模板
3. 这个模板实际上用于两种模式：
   - 如果代码中设置了 `emailRedirectTo`：发送 Magic Link
   - 如果代码中**没有设置** `emailRedirectTo`：发送 OTP 验证码

4. 确保模板中包含验证码变量：
   ```
   您的验证码是：{{ .Token }}
   
   验证码有效期为 10 分钟。
   
   如果这不是您的操作，请忽略此邮件。
   ```

### 2. 检查代码配置

#### 确保代码正确

代码中**必须不设置** `emailRedirectTo`：

```typescript
// ✅ 正确：发送 OTP 验证码
const { error } = await supabase.auth.signInWithOtp({
  email,
  options: {
    shouldCreateUser: true,
    // 不设置 emailRedirectTo = 发送验证码
  },
})

// ❌ 错误：会发送 Magic Link
const { error } = await supabase.auth.signInWithOtp({
  email,
  options: {
    shouldCreateUser: true,
    emailRedirectTo: 'https://www.arenafi.org/login', // 这会发送链接
  },
})
```

### 3. 环境变量检查

确保环境变量正确设置：

```bash
# 生产环境
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_APP_URL=https://www.arenafi.org

# 开发环境
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. 测试步骤

#### 测试发送 OTP

1. 访问 `/login` 页面
2. 点击"还没有账号？使用验证码注册"
3. 输入邮箱地址
4. 点击"发送验证码"
5. **检查邮箱**：
   - ✅ 应该收到包含 **6位数字验证码** 的邮件
   - ❌ 不应该收到包含链接的邮件

#### 如果仍然收到链接

1. **检查 Supabase Dashboard**：
   - 进入 **Authentication** → **Settings**
   - 检查 **Site URL** 是否正确设置为 `https://www.arenafi.org`
   - 检查 **Redirect URLs** 是否包含正确的 URL

2. **检查代码**：
   - 确保 `handleSendCode` 函数中没有设置 `emailRedirectTo`
   - 检查是否有其他地方调用了 `signInWithOtp` 并设置了 `emailRedirectTo`

3. **清除缓存并重试**：
   - 清除浏览器缓存
   - 使用新的邮箱地址测试
   - 检查 Supabase Dashboard → Authentication → Logs 查看实际发送的内容

### 5. 常见问题

#### Q: 为什么我收到的是链接而不是验证码？

A: 可能的原因：
1. Supabase Dashboard 中的 Site URL 配置错误
2. 代码中意外设置了 `emailRedirectTo`
3. Supabase 的 Email Auth 配置不正确

#### Q: 如何确保发送的是验证码？

A: 
1. 代码中**不要设置** `emailRedirectTo`
2. 在 Supabase Dashboard 中确保 Site URL 正确
3. 测试时检查邮箱内容

#### Q: 验证码邮件中的链接指向 localhost 怎么办？

A: 
1. 在 Supabase Dashboard → Authentication → Settings → URL Configuration
2. 设置 **Site URL** 为 `https://www.arenafi.org`
3. 保存设置
4. 重新发送验证码

#### Q: 开发环境和生产环境如何区分？

A: 
- 使用环境变量 `NEXT_PUBLIC_APP_URL` 区分
- 开发环境：`http://localhost:3000`
- 生产环境：`https://www.arenafi.org`

### 6. 验证配置是否正确

运行以下检查：

1. ✅ Supabase Dashboard → Authentication → Settings → Site URL = `https://www.arenafi.org`
2. ✅ 代码中 `signInWithOtp` 没有设置 `emailRedirectTo`
3. ✅ 环境变量 `NEXT_PUBLIC_APP_URL` 正确设置
4. ✅ Email Templates 中包含 `{{ .Token }}` 变量

### 7. 如果问题仍然存在

1. **检查 Supabase 日志**：
   - 进入 Supabase Dashboard → Authentication → Logs
   - 查看实际发送的邮件类型

2. **联系 Supabase 支持**：
   - 如果配置都正确但仍然发送链接，可能需要联系 Supabase 支持

3. **使用自定义邮件服务**：
   - 如果 Supabase 的邮件服务有问题，可以考虑使用自定义邮件服务（如 SendGrid、AWS SES）

## 相关文档

- [登录流程说明](./LOGIN_FLOW.md)
- [OTP vs Magic Link](./OTP_VS_MAGIC_LINK.md)
- [Supabase 设置指南](./SUPABASE_SETUP.md)

