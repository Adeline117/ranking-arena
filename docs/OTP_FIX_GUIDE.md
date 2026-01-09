# OTP 验证码修复完整指南

## 问题描述

新用户注册时点击"发送验证码"，但邮箱收到的是 Magic Link（链接）而不是 6 位数字验证码。

## 🚀 快速修复（最重要的步骤）

**只需要完成这一步**：

### 步骤 A：设置 Site URL（最关键）

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目
3. 点击左侧边栏的 **Authentication** → **Settings**
4. 向下滚动找到 **URL Configuration** 部分
5. 将 **Site URL** 设置为：`https://www.arenafi.org`
6. 点击 **Save**（保存）

**这就是最关键的一步！** 

### 关于其他选项（如果看到代码配置）

如果你点击其他选项（如 Confirm sign up、Magic link）后看到的是代码或配置文件，而不是开关按钮：

- ✅ **这是正常的**，说明这些设置是通过代码控制的
- ✅ **不需要修改**这些代码配置
- ✅ **关键是**：确保你的应用代码中**没有设置 `emailRedirectTo`**（已确认正确 ✅）
- ✅ 即使这些选项显示的是代码，只要你的代码正确（不设置 `emailRedirectTo`），就会发送验证码而不是链接

**重要理解**：
- 如果你看到的是代码而不是开关按钮，**不要担心，可以忽略**
- **最关键的是 Site URL 配置**（步骤 A）
- 代码已经正确配置（没有设置 `emailRedirectTo`），这才是确保发送验证码的关键

**完成步骤 A（设置 Site URL）后，就可以重新测试发送验证码了。**

---

## 详细说明

## 根本原因

Supabase 的 `signInWithOtp` 方法的行为取决于：
1. **代码中是否设置了 `emailRedirectTo`**
2. **Supabase Dashboard 中的 Site URL 配置**
3. **Email Templates 的配置**

即使代码中没有设置 `emailRedirectTo`，如果 Supabase Dashboard 配置不正确，仍然可能发送 Magic Link。

## 解决方案

### 步骤 1：检查 Supabase Dashboard 配置

**⚠️ 最重要的一步**：检查 **Site URL** 配置。这是确保发送验证码而不是链接的关键。

#### 1.1 检查 Site URL（必须）

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目（左上角下拉菜单）
3. 在左侧边栏找到并点击 **Authentication**（认证）
4. 点击 **Settings**（设置）标签页
5. 在页面中找到 **URL Configuration**（URL 配置）部分
   - 可能在不同位置：顶部、中间或底部
   - 如果找不到，尝试向下滚动
6. 找到 **Site URL** 输入框
7. **Site URL** 必须设置为：`https://www.arenafi.org`
   - ❌ 不要设置为 `http://localhost:3000`
   - ❌ 不要设置为空或默认值
   - ✅ 必须设置为 `https://www.arenafi.org`
8. 点击 **Save**（保存）按钮

**如果找不到 Site URL 设置**：
- 尝试在 **Authentication** → **Settings** 页面中搜索 "Site URL"
- 或者查看页面顶部的 **Configuration** 部分
- 如果仍然找不到，请截图并联系 Supabase 支持

#### 1.2 检查 Redirect URLs（推荐）

在 **URL Configuration** 同一部分，找到 **Redirect URLs**：

1. 点击 **Redirect URLs** 输入框或"添加"按钮
2. 添加以下 URL（每行一个）：
   - `https://www.arenafi.org/login`
   - `https://www.arenafi.org/**`
   - `http://localhost:3000/login`（仅开发环境，可选）
3. 点击 **Save**（保存）按钮

**如果找不到 Redirect URLs**：
- 这不是必需的，但建议添加
- 如果找不到，可以跳过这一步

#### 1.3 检查 Email Auth 设置（如果看到代码配置）

**注意**：如果你点击这些选项后看到的是代码或配置文件，而不是开关按钮，这是正常的。这些设置可以通过代码控制。

在这些选项的详细页面中：

1. **Confirm sign up** - 点击进入
   - 如果看到代码配置，说明这是通过代码控制的
   - **重要**：OTP 验证码注册不需要邮箱确认
   - 如果代码中显示了 `enable_confirmations: true` 或类似配置，可以尝试修改为 `false`
   - **但实际上**：最重要的是确保代码中**没有设置 `emailRedirectTo`**（已确认正确），这样即使这个设置开启，也不会影响 OTP 验证码的发送

2. **Magic link** - 点击进入
   - 如果看到代码配置，说明这是通过代码控制的
   - **关键理解**：只要代码中**没有设置 `emailRedirectTo`**，Supabase 会发送 OTP 验证码而不是 Magic Link
   - 即使 Magic Link 选项是开启的，只要代码正确（不设置 `emailRedirectTo`），仍然会发送验证码
   - **建议**：可以保持默认设置，代码已经正确处理了

3. **其他选项**（Change email address, Reset password, Reauthentication）
   - 这些与 OTP 验证码注册无关，可以保持默认设置
   - 如果看到代码配置，不需要修改

**重要提醒**：
- 如果你看到的是代码配置而不是简单的开关，**不要担心**
- 最关键的是 **Site URL** 配置（步骤 1.1）
- 代码已经正确配置（没有设置 `emailRedirectTo`），这才是确保发送验证码的关键

#### 1.4 检查 Email Templates（可选）

**注意**：如果找不到 Email Templates 设置，可以跳过这一步。Supabase 会使用默认模板。

如果界面中有 Email Templates：

1. 在 **Authentication** 菜单下查找：
   - **Email Templates**
   - **Templates**
   - **Email Configuration**
   - 或者在 **Settings** 页面中查找 **Templates** 部分

2. 如果找到，查找 **Magic Link** 或 **OTP** 模板（名称可能不同）

3. 模板应该包含变量 `{{ .Token }}`，这会被替换为验证码

**如果找不到 Email Templates**：
- Supabase 使用默认模板，通常会自动处理 OTP 验证码
- 只要代码中没有设置 `emailRedirectTo`，Supabase 会发送验证码而不是链接
- 重点是确保 **Site URL** 配置正确（步骤 1.1）

### 步骤 2：验证代码配置（已确认正确）

代码已经正确配置，确保：

1. ✅ `handleSendCode` 函数中**没有设置** `emailRedirectTo`
2. ✅ `handleSendLoginCode` 函数中**没有设置** `emailRedirectTo`
3. ✅ 只有 `handleSendLoginLink` 函数设置了 `emailRedirectTo`（这是正确的，因为这是发送 Magic Link）

**代码已经正确，无需修改。**

### 步骤 3：检查环境变量（推荐）

确保 Vercel 环境变量正确设置：

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 选择你的项目
3. 进入 **Settings** → **Environment Variables**
4. 确保以下变量已设置：
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://your-project.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `your-anon-key`
   - `NEXT_PUBLIC_APP_URL` = `https://www.arenafi.org`

**如果环境变量未设置或错误**：
- 添加或更新环境变量
- 重新部署项目（Vercel 会自动触发）

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

### 必须检查的项目：

- [ ] **Site URL 已设置**：Supabase Dashboard → Authentication → Settings → URL Configuration → Site URL = `https://www.arenafi.org` ⭐ **最关键**
- [ ] **代码正确**：代码中 `signInWithOtp` 没有设置 `emailRedirectTo`（注册和登录验证码）- ✅ 已确认正确
- [ ] **测试通过**：测试时收到的是 6 位数字验证码，而不是链接
- [ ] **浏览器控制台无错误**：打开 F12 查看控制台，应该看到 `[OTP] 发送成功` 日志

### 可选检查的项目：

- [ ] **Confirm sign up 设置**：如果看到代码配置而不是开关，不需要修改（代码已正确处理）
- [ ] **Magic link 设置**：如果看到代码配置而不是开关，不需要修改（代码已正确处理）

### 推荐检查的项目：

- [ ] **Redirect URLs 已添加**：在 URL Configuration 中添加了 `https://www.arenafi.org/login`
- [ ] **环境变量正确**：Vercel 环境变量 `NEXT_PUBLIC_APP_URL` = `https://www.arenafi.org`

### 可选检查的项目：

- [ ] Email Auth 设置（如果界面中有）
- [ ] Email Templates（如果界面中有）

**最重要的检查**：Site URL 是否正确设置为 `https://www.arenafi.org`

## 相关文档

- [登录流程说明](./LOGIN_FLOW.md)
- [OTP vs Magic Link](./OTP_VS_MAGIC_LINK.md)
- [Supabase 设置指南](./SUPABASE_SETUP.md)
- [Supabase OTP 修复](./SUPABASE_OTP_FIX.md)

