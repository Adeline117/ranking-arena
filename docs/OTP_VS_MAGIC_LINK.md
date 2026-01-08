# Supabase OTP 验证码 vs Magic Link 配置

## 问题说明

Supabase 的 `signInWithOtp` 方法根据配置会发送两种不同类型的邮件：

1. **OTP 验证码**：6位数字验证码
2. **Magic Link**：包含登录链接的邮件

## 如何发送 OTP 验证码（而不是 Magic Link）

### 关键配置

要发送 OTP 验证码，**不要设置 `emailRedirectTo`**：

```typescript
// ✅ 正确：发送 OTP 验证码
const { error } = await supabase.auth.signInWithOtp({
  email,
  options: {
    shouldCreateUser: true,
    // 不设置 emailRedirectTo，这样会发送 6 位数字验证码
  },
})

// ❌ 错误：会发送 Magic Link
const { error } = await supabase.auth.signInWithOtp({
  email,
  options: {
    shouldCreateUser: true,
    emailRedirectTo: `${window.location.origin}/login`, // 这会发送链接而不是验证码
  },
})
```

## Supabase Dashboard 配置

### 1. 确保 OTP 已启用

1. 进入 Supabase Dashboard
2. 点击 **Authentication** → **Settings**
3. 找到 **Auth Providers** → **Email**
4. 确保 **Enable Email provider** 已启用
5. **OTP expiry**: `3600` (1小时)
6. **OTP length**: `6` (6位数字)

### 2. 邮箱模板配置

1. 进入 **Authentication** → **Email Templates**
2. 找到 **Magic Link** 模板
3. 这个模板实际上也用于 OTP，但内容会不同：
   - 如果设置了 `emailRedirectTo`：邮件包含登录链接
   - 如果没有设置 `emailRedirectTo`：邮件包含 6 位数字验证码

### 3. 自定义 OTP 邮件模板（可选）

如果你想自定义 OTP 邮件内容，可以在 Supabase Dashboard 中编辑模板：

1. 进入 **Authentication** → **Email Templates**
2. 编辑 **Magic Link** 模板
3. 使用变量：
   - `{{ .Token }}` - 6位数字验证码
   - `{{ .TokenHash }}` - 验证码哈希
   - `{{ .SiteURL }}` - 网站URL
   - `{{ .Email }}` - 用户邮箱

示例模板：
```
您的验证码是：{{ .Token }}

验证码有效期为 1 小时。

如果这不是您的操作，请忽略此邮件。
```

## 代码示例

### 发送 OTP 验证码

```typescript
const handleSendOTP = async () => {
  const { error } = await supabase.auth.signInWithOtp({
    email: 'user@example.com',
    options: {
      shouldCreateUser: true,
      // 不设置 emailRedirectTo = 发送 OTP 验证码
    },
  })
  
  if (error) {
    console.error('发送失败:', error.message)
  } else {
    console.log('验证码已发送到邮箱')
  }
}
```

### 验证 OTP 验证码

```typescript
const handleVerifyOTP = async (code: string) => {
  const { data, error } = await supabase.auth.verifyOtp({
    email: 'user@example.com',
    token: code, // 6位数字验证码
    type: 'email',
  })
  
  if (error) {
    console.error('验证失败:', error.message)
  } else {
    console.log('验证成功，用户已登录')
  }
}
```

### 发送 Magic Link（如果需要）

```typescript
const handleSendMagicLink = async () => {
  const { error } = await supabase.auth.signInWithOtp({
    email: 'user@example.com',
    options: {
      shouldCreateUser: false, // 登录时不创建新用户
      emailRedirectTo: `${window.location.origin}/login`, // 设置重定向URL = 发送 Magic Link
    },
  })
  
  if (error) {
    console.error('发送失败:', error.message)
  } else {
    console.log('登录链接已发送到邮箱')
  }
}
```

## 常见问题

### Q: 为什么我收到的是链接而不是验证码？

A: 因为你设置了 `emailRedirectTo`。要发送验证码，**不要设置** `emailRedirectTo`。

### Q: 如何同时支持 OTP 和 Magic Link？

A: 使用两个不同的函数：
- `handleSendOTP()` - 不设置 `emailRedirectTo`，发送验证码
- `handleSendMagicLink()` - 设置 `emailRedirectTo`，发送链接

### Q: OTP 验证码在哪里查看？

A: 
- 检查邮箱（包括垃圾邮件文件夹）
- 在 Supabase Dashboard → Authentication → Logs 中查看（开发环境）

### Q: 验证码有效期是多久？

A: 默认 1 小时（3600 秒），可在 Supabase Dashboard 中配置。

## 测试步骤

1. **测试发送 OTP**：
   ```typescript
   await supabase.auth.signInWithOtp({
     email: 'test@example.com',
     options: { shouldCreateUser: true }
   })
   ```

2. **检查邮箱**：
   - 应该收到包含 6 位数字验证码的邮件
   - 不是包含链接的邮件

3. **验证 OTP**：
   ```typescript
   await supabase.auth.verifyOtp({
     email: 'test@example.com',
     token: '123456', // 从邮件中获取的验证码
     type: 'email',
   })
   ```



