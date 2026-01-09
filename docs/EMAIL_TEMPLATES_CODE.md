# Supabase Email Templates 修改代码

## 需要修改的模板

### 1. Magic Link（最重要 - 必须修改）

**原代码**（你当前的）：
```html
<h2>Magic Link</h2>

<p>Follow this link to login:</p>
<p><a href="{{ .ConfirmationURL }}">Log In</a></p>
```

**修改为**（使用验证码）：
```html
<h2>验证码登录</h2>

<p>您的验证码是：<strong>{{ .Token }}</strong></p>
<p>验证码有效期为 10 分钟。</p>
<p>如果这不是您的操作，请忽略此邮件。</p>
```

**或者**（同时支持验证码和链接）：
```html
{{ if .Token }}
  <h2>验证码登录</h2>
  <p>您的验证码是：<strong>{{ .Token }}</strong></p>
  <p>验证码有效期为 10 分钟。</p>
  <p>如果这不是您的操作，请忽略此邮件。</p>
{{ else if .ConfirmationURL }}
  <h2>Magic Link 登录</h2>
  <p>点击链接登录：<a href="{{ .ConfirmationURL }}">Log In</a></p>
{{ end }}
```

---

### 2. Confirm signup（可选修改）

**原代码**（你当前的）：
```html
<h2>Confirm your signup</h2>

<p>Follow this link to confirm your user:</p>
<p><a href="{{ .ConfirmationURL }}">Confirm your mail</a></p>
```

**修改为**（如果使用验证码注册）：
```html
<h2>确认注册</h2>

<p>您的验证码是：<strong>{{ .Token }}</strong></p>
<p>请在注册页面输入此验证码完成注册。</p>
<p>验证码有效期为 10 分钟。</p>
<p>如果这不是您的操作，请忽略此邮件。</p>
```

**注意**：如果你使用的是 OTP 注册流程（不设置 emailRedirectTo），建议保持原样或修改为验证码格式。但通常这个模板用于邮箱确认链接，不是验证码。

---

### 3. Confirm Change of Email（不需要修改）

**原代码**（你当前的）：
```html
<h2>Confirm Change of Email</h2>

<p>Follow this link to confirm the update of your email from {{ .Email }} to {{ .NewEmail }}:</p>
<p><a href="{{ .ConfirmationURL }}">Change Email</a></a></p>
```

**说明**：这个模板用于邮箱更改确认，不需要修改。它本身就是使用链接确认的。

---

### 4. Reset Password（不需要修改）

**原代码**（你当前的）：
```html
<h2>Reset Password</h2>

<p>Follow this link to reset the password for your user:</p>
<p><a href="{{ .ConfirmationURL }}">Reset Password</a></p>
```

**说明**：这个模板用于密码重置，不需要修改。它本身就是使用链接重置的。

---

### 5. Confirm reauthentication（不需要修改）

**原代码**（你当前的）：
```html
<h2>Confirm reauthentication</h2>

<p>Enter the code: {{ .Token }}</p>
```

**说明**：这个模板已经正确使用了 `{{ .Token }}`，不需要修改。

---

### 6. You have been invited（不需要修改）

**原代码**（你当前的）：
```html
<h2>You have been invited</h2>

<p>You have been invited to create a user on {{ .SiteURL }}. Follow this link to accept the invite:</p>
<p><a href="{{ .ConfirmationURL }}">Accept the invite</a></p>
```

**说明**：这个模板用于邀请用户，不需要修改。它本身就是使用链接的。

---

## 修改步骤

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目
3. 进入 **Authentication** → **Settings**
4. 向下滚动找到 **Email Templates** 部分
5. 找到 **Magic Link** 模板，点击进入
6. 将模板内容替换为上面的"修改为"代码
7. 点击 **Save**（保存）

## 重要提醒

- **只有 Magic Link 模板是必须修改的**，因为它用于登录/注册时的验证码发送
- 其他模板可以保持原样，因为它们的用途不同
- 最关键的是确保代码中**没有设置 `emailRedirectTo`**（已确认正确 ✅）
- Site URL 必须设置为 `https://www.arenafi.org`

## 变量说明

- `{{ .Token }}` - 6 位数字验证码（用于 OTP）
- `{{ .ConfirmationURL }}` - 确认链接（用于 Magic Link）
- `{{ .Email }}` - 当前邮箱地址
- `{{ .NewEmail }}` - 新邮箱地址
- `{{ .SiteURL }}` - 网站 URL

