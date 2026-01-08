# OTP 验证码修复完整指南

## 问题描述

新用户注册时点击"发送验证码"，但邮箱收到的是 Magic Link（链接）而不是 6 位数字验证码。

## 根本原因

Supabase 的 `signInWithOtp` 方法的行为取决于：
1. **代码中是否设置了 `emailRedirectTo`**
2. **Supabase Dashboard 中的 Site URL 配置**
3. **Email Templates 的配置**

即使代码中没有设置 `emailRedirectTo`，如果 Supabase Dashboard 配置不正确，仍然可能发送 Magic Link。

## 解决方案

### 步骤 1：检查 Supabase Dashboard 配置

#### 1.1 检查 Site URL

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目
3. 进入 **Authentication** → **Settings**
4. 找到 **URL Configuration** 部分
5. **Site URL** 必须设置为：`https://www.arenafi.org`
   - ❌ 不要设置为 `http://localhost:3000`
   - ❌ 不要设置为空
   - ✅ 必须设置为 `https://www.arenafi.org`

#### 1.2 检查 Redirect URLs

在 **Redirect URLs** 中添加：
- `https://www.arenafi.org/login`
- `https://www.arenafi.org/**`
- `http://localhost:3000/login`（仅开发环境）

#### 1.3 检查 Email Auth 设置

1. 在 **Authentication** → **Settings** → **Auth Providers** → **Email**
2. 确保：
   - ✅ **Enable Email provider**: 已启用
   - ✅ **Confirm email**: **关闭**（OTP 不需要邮箱确认）
   - ✅ **Secure email change**: 关闭（可选）

#### 1.4 检查 Email Templates

1. 进入 **Authentication** → **Email Templates**
2. 找到 **Magic Link** 模板（这个模板实际上用于两种模式）
3. 确保模板中包含验证码变量：
   ```
   您的验证码是：{{ .Token }}
   
   验证码有效期为 10 分钟。
   
   如果这不是您的操作，请忽略此邮件。
   ```

**重要**：即使模板名称是 "Magic Link"，如果不设置 `emailRedirectTo`，Supabase 会使用这个模板发送 OTP 验证码。

### 步骤 2：验证代码配置

代码已经正确配置，确保：

1. ✅ `handleSendCode` 函数中**没有设置** `emailRedirectTo`
2. ✅ `handleSendLoginCode` 函数中**没有设置** `emailRedirectTo`
3. ✅ 只有 `handleSendLoginLink` 函数设置了 `emailRedirectTo`（这是正确的，因为这是发送 Magic Link）

### 步骤 3：检查环境变量

确保 Vercel 环境变量正确设置：

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_APP_URL=https://www.arenafi.org
```

### 步骤 4：测试

1. 访问 `https://www.arenafi.org/login`
2. 点击"还没有账号？使用验证码注册"
3. 输入邮箱地址
4. 点击"发送验证码"
5. **检查邮箱**：
   - ✅ 应该收到包含 **6位数字验证码** 的邮件
   - 验证码格式：`123456`（6位数字）
   - 邮件主题应该包含"验证码"或"OTP"
   - ❌ 不应该收到包含链接的邮件

### 步骤 5：如果仍然收到链接

#### 5.1 检查 Supabase 日志

1. 进入 Supabase Dashboard → **Authentication** → **Logs**
2. 查看最近发送的邮件记录
3. 检查邮件类型：
   - 如果显示 "Magic Link"，说明配置有问题
   - 如果显示 "OTP"，说明配置正确

#### 5.2 清除缓存并重试

1. 清除浏览器缓存
2. 使用新的邮箱地址测试（避免使用已注册的邮箱）
3. 等待 1-2 分钟后再试（避免频率限制）

#### 5.3 检查控制台日志

打开浏览器开发者工具（F12），查看 Console 标签：

- 应该看到 `[OTP] 发送验证码到: your@email.com`
- 应该看到 `[OTP] 发送成功: {...}`
- 如果看到错误，检查错误信息

#### 5.4 联系 Supabase 支持

如果以上步骤都正确但仍然发送链接，可能需要：
1. 联系 Supabase 支持
2. 或者检查 Supabase 项目设置中是否有其他配置影响

## 代码改进

代码已经添加了详细的日志记录：

- `[OTP]` 前缀：注册验证码相关日志
- `[OTP Login]` 前缀：登录验证码相关日志
- 所有错误都会记录到控制台，方便调试

## 常见问题

### Q: 为什么我收到的是链接而不是验证码？

A: 可能的原因：
1. Supabase Dashboard 中的 Site URL 配置错误（最常见）
2. Email Templates 配置不正确
3. Supabase 的 Email Auth 配置问题

### Q: 如何确保发送的是验证码？

A: 
1. ✅ 代码中**不要设置** `emailRedirectTo`（已确认正确）
2. ✅ Supabase Dashboard 中 Site URL 设置为 `https://www.arenafi.org`
3. ✅ 测试时检查邮箱内容

### Q: 验证码邮件中的链接指向 localhost 怎么办？

A: 
1. 在 Supabase Dashboard → Authentication → Settings → URL Configuration
2. 设置 Site URL 为 `https://www.arenafi.org`
3. 保存设置
4. 重新发送验证码

### Q: 开发环境和生产环境如何区分？

A: 
- 使用环境变量 `NEXT_PUBLIC_APP_URL` 区分
- 开发环境：`http://localhost:3000`
- 生产环境：`https://www.arenafi.org`

## 验证清单

在修复后，请确认：

- [ ] Supabase Dashboard → Authentication → Settings → Site URL = `https://www.arenafi.org`
- [ ] 代码中 `signInWithOtp` 没有设置 `emailRedirectTo`（注册和登录验证码）
- [ ] 环境变量 `NEXT_PUBLIC_APP_URL` 正确设置
- [ ] Email Templates 中包含 `{{ .Token }}` 变量
- [ ] 测试时收到的是 6 位数字验证码，而不是链接
- [ ] 浏览器控制台没有错误日志

## 相关文档

- [登录流程说明](./LOGIN_FLOW.md)
- [OTP vs Magic Link](./OTP_VS_MAGIC_LINK.md)
- [Supabase 设置指南](./SUPABASE_SETUP.md)
- [Supabase OTP 修复](./SUPABASE_OTP_FIX.md)

