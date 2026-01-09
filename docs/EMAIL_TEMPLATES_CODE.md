# Supabase Email Templates 修改代码

## 需要修改的模板

### 1. Magic Link（最重要 - 必须修改）

**原代码**（你当前的）：
```html
<h2>Magic Link</h2>

<p>Follow this link to login:</p>
<p><a href="{{ .ConfirmationURL }}">Log In</a></p>
```

**修改为**（双语 - 使用验证码）：
```html
<h2>验证码登录 / Verification Code Login</h2>

<p>您的验证码是：<strong>{{ .Token }}</strong></p>
<p>Your verification code is: <strong>{{ .Token }}</strong></p>

<p>验证码有效期为 10 分钟。</p>
<p>The verification code is valid for 10 minutes.</p>

<p>如果这不是您的操作，请忽略此邮件。</p>
<p>If this was not your action, please ignore this email.</p>
```

**或者**（双语 - 同时支持验证码和链接）：
```html
{{ if .Token }}
  <h2>验证码登录 / Verification Code Login</h2>
  
  <p>您的验证码是：<strong>{{ .Token }}</strong></p>
  <p>Your verification code is: <strong>{{ .Token }}</strong></p>
  
  <p>验证码有效期为 10 分钟。</p>
  <p>The verification code is valid for 10 minutes.</p>
  
  <p>如果这不是您的操作，请忽略此邮件。</p>
  <p>If this was not your action, please ignore this email.</p>
{{ else if .ConfirmationURL }}
  <h2>Magic Link 登录 / Magic Link Login</h2>
  
  <p>点击链接登录：<a href="{{ .ConfirmationURL }}">Log In</a></p>
  <p>Click the link to login: <a href="{{ .ConfirmationURL }}">Log In</a></p>
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

**修改为**（双语 - 如果使用验证码注册）：
```html
<h2>确认注册 / Confirm Registration</h2>

<p>您的验证码是：<strong>{{ .Token }}</strong></p>
<p>Your verification code is: <strong>{{ .Token }}</strong></p>

<p>请在注册页面输入此验证码完成注册。</p>
<p>Please enter this verification code on the registration page to complete registration.</p>

<p>验证码有效期为 10 分钟。</p>
<p>The verification code is valid for 10 minutes.</p>

<p>如果这不是您的操作，请忽略此邮件。</p>
<p>If this was not your action, please ignore this email.</p>
```

**注意**：如果你使用的是 OTP 注册流程（不设置 emailRedirectTo），建议保持原样或修改为验证码格式。但通常这个模板用于邮箱确认链接，不是验证码。

---

### 3. Confirm Change of Email（不需要修改）

**原代码**（你当前的）：
```html
<h2>Confirm Change of Email</h2>

<p>Follow this link to confirm the update of your email from {{ .Email }} to {{ .NewEmail }}:</p>
<p><a href="{{ .ConfirmationURL }}">Change Email</a></p>
```

**修改为**（双语 - 可选）：
```html
<h2>确认更改邮箱 / Confirm Change of Email</h2>

<p>请点击链接确认将您的邮箱从 {{ .Email }} 更新为 {{ .NewEmail }}：</p>
<p>Please click the link to confirm updating your email from {{ .Email }} to {{ .NewEmail }}:</p>

<p><a href="{{ .ConfirmationURL }}">更改邮箱 / Change Email</a></p>

<p>如果这不是您的操作，请忽略此邮件。</p>
<p>If this was not your action, please ignore this email.</p>
```

**说明**：这个模板用于邮箱更改确认，使用链接确认。如果需要双语可以修改，否则保持原样即可。

---

### 4. Reset Password（不需要修改）

**原代码**（你当前的）：
```html
<h2>Reset Password</h2>

<p>Follow this link to reset the password for your user:</p>
<p><a href="{{ .ConfirmationURL }}">Reset Password</a></p>
```

**修改为**（双语 - 可选）：
```html
<h2>重置密码 / Reset Password</h2>

<p>请点击链接重置您的密码：</p>
<p>Please click the link to reset your password:</p>

<p><a href="{{ .ConfirmationURL }}">重置密码 / Reset Password</a></p>

<p>如果这不是您的操作，请忽略此邮件。</p>
<p>If this was not your action, please ignore this email.</p>
```

**说明**：这个模板用于密码重置，使用链接重置。如果需要双语可以修改，否则保持原样即可。

---

### 5. Confirm reauthentication（不需要修改）

**原代码**（你当前的）：
```html
<h2>Confirm reauthentication</h2>

<p>Enter the code: {{ .Token }}</p>
```

**修改为**（双语）：
```html
<h2>确认重新验证 / Confirm Reauthentication</h2>

<p>请输入验证码：<strong>{{ .Token }}</strong></p>
<p>Enter the code: <strong>{{ .Token }}</strong></p>

<p>如果这不是您的操作，请忽略此邮件。</p>
<p>If this was not your action, please ignore this email.</p>
```

**说明**：这个模板已经正确使用了 `{{ .Token }}`，如果需要双语可以修改。

---

### 6. You have been invited（不需要修改）

**原代码**（你当前的）：
```html
<h2>You have been invited</h2>

<p>You have been invited to create a user on {{ .SiteURL }}. Follow this link to accept the invite:</p>
<p><a href="{{ .ConfirmationURL }}">Accept the invite</a></p>
```

**修改为**（双语 - 可选）：
```html
<h2>邀请注册 / You have been invited</h2>

<p>您已被邀请在 {{ .SiteURL }} 创建账户。请点击链接接受邀请：</p>
<p>You have been invited to create a user on {{ .SiteURL }}. Please click the link to accept the invite:</p>

<p><a href="{{ .ConfirmationURL }}">接受邀请 / Accept the invite</a></p>

<p>如果这不是您的操作，请忽略此邮件。</p>
<p>If this was not your action, please ignore this email.</p>
```

**说明**：这个模板用于邀请用户，使用链接。如果需要双语可以修改，否则保持原样即可。

---

## 修改步骤

1. 登录 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目
3. 进入 **Authentication** → **Settings**
4. 向下滚动找到 **Email Templates** 部分
5. 找到 **Magic Link** 模板，点击进入
6. 将模板内容替换为上面的"修改为（双语）"代码
7. 点击 **Save**（保存）

**如果需要修改其他模板为双语**：
- 按照相同的步骤，找到对应的模板
- 将上面的"修改为（双语）"代码复制粘贴进去
- 保存即可

## 重要提醒

- **Magic Link 模板是必须修改的**（双语版本），因为它用于登录/注册时的验证码发送
- **Confirm signup 模板建议修改为双语**（如果使用验证码注册）
- **Confirm reauthentication 模板建议修改为双语**（已使用 Token）
- 其他模板（Change Email, Reset Password, Invite）是可选的，按需修改
- 最关键的是确保代码中**没有设置 `emailRedirectTo`**（已确认正确 ✅）
- Site URL 必须设置为 `https://www.arenafi.org`

## 变量说明

- `{{ .Token }}` - 6 位数字验证码（用于 OTP）
- `{{ .ConfirmationURL }}` - 确认链接（用于 Magic Link）
- `{{ .Email }}` - 当前邮箱地址
- `{{ .NewEmail }}` - 新邮箱地址
- `{{ .SiteURL }}` - 网站 URL

