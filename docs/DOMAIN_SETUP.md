# 域名配置指南

本指南将帮助您将 `www.arenafi.org` 域名连接到您的 Ranking Arena 网站。

## 前提条件

1. ✅ 已购买 `arenafi.org` 域名
2. ✅ 网站已部署到 Vercel（或准备部署）
3. ✅ 拥有域名注册商的管理权限

## 步骤 1: 在 Vercel 中添加域名

### 1.1 登录 Vercel 控制台

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 选择您的 `ranking-arena` 项目

### 1.2 添加自定义域名

1. 进入项目后，点击 **Settings**（设置）
2. 在左侧菜单选择 **Domains**（域名）
3. 在 "Domains" 输入框中输入：`www.arenafi.org`
4. 点击 **Add**（添加）

### 1.3 添加根域名（可选但推荐）

为了支持 `arenafi.org`（不带 www），也添加根域名：
1. 再次在输入框中输入：`arenafi.org`
2. 点击 **Add**（添加）

Vercel 会自动将根域名重定向到 www 子域名。

## 步骤 2: 配置 DNS 记录

Vercel 会显示需要配置的 DNS 记录。根据您的域名注册商，按以下方式配置：

### 2.1 对于 www 子域名

在您的域名注册商的 DNS 管理面板中添加以下记录：

**类型 A 记录（推荐）：**
```
类型: A
名称: www
值: 76.76.21.21
TTL: 3600（或自动）
```

**或使用 CNAME 记录（更灵活）：**
```
类型: CNAME
名称: www
值: cname.vercel-dns.com.
TTL: 3600（或自动）
```

### 2.2 对于根域名（arenafi.org）

**使用 A 记录：**
```
类型: A
名称: @（或留空，取决于注册商）
值: 76.76.21.21
TTL: 3600
```

**或使用 CNAME 记录（如果注册商支持）：**
```
类型: CNAME
名称: @（或留空）
值: cname.vercel-dns.com.
TTL: 3600
```

> **注意**：某些注册商不支持根域名的 CNAME 记录。如果遇到此情况，请使用 A 记录。

### 2.3 常见域名注册商的 DNS 配置位置

- **Namecheap**: Domain List → Manage → Advanced DNS
- **GoDaddy**: My Products → DNS → Manage Zones
- **Cloudflare**: 选择域名 → DNS → Records
- **Google Domains**: DNS → Custom records
- **阿里云**: 域名控制台 → 解析设置

## 步骤 3: 等待 DNS 传播

DNS 更改通常需要几分钟到 48 小时才能完全传播。通常：
- 大多数情况下：15 分钟 - 2 小时
- 最长可能需要：48 小时

您可以使用以下工具检查 DNS 传播状态：
- [whatsmydns.net](https://www.whatsmydns.net/)
- [dnschecker.org](https://dnschecker.org/)

## 步骤 4: 验证域名配置

### 4.1 在 Vercel 中验证

1. 返回 Vercel 项目的 **Settings → Domains**
2. 等待域名状态变为 **Valid**（有效）
3. 如果显示错误，检查 DNS 配置是否正确

### 4.2 测试访问

DNS 传播完成后，访问：
- `https://www.arenafi.org` - 应该显示您的网站
- `https://arenafi.org` - 应该自动重定向到 www 版本

## 步骤 5: 更新环境变量

域名配置完成后，更新 Vercel 项目中的环境变量：

1. 在 Vercel 项目中，进入 **Settings → Environment Variables**
2. 更新或添加以下变量：

```
NEXT_PUBLIC_APP_URL=https://www.arenafi.org
```

3. 如果使用其他环境（Preview、Production），确保为每个环境都设置了正确的值
4. 保存后，Vercel 会自动触发新的部署

## 步骤 6: 配置 HTTPS（自动）

Vercel 会自动为您的域名配置 SSL 证书（通过 Let's Encrypt）。无需手动操作，只需等待：
- DNS 验证通过后
- Vercel 会自动申请和配置 SSL 证书
- 通常需要几分钟到几小时

## 步骤 7: 更新应用配置（如需要）

检查以下文件，确保域名配置正确：

### 7.1 更新 `app/layout.tsx` 中的 metadataBase

```typescript
export const metadata = {
  metadataBase: new URL('https://www.arenafi.org'),
  // ... 其他配置
}
```

### 7.2 检查 `app/sitemap.ts` 和 `app/robots.ts`

确保这些文件使用正确的域名。

## 常见问题排查

### 问题 1: DNS 记录未生效

**解决方案：**
- 确认 DNS 记录已正确保存
- 清除本地 DNS 缓存：`sudo dscacheutil -flushcache`（macOS）
- 等待更长时间（最多 48 小时）

### 问题 2: Vercel 显示 "Invalid Configuration"

**解决方案：**
- 检查 DNS 记录类型和值是否正确
- 确保没有冲突的 DNS 记录
- 确认域名已正确添加到 Vercel

### 问题 3: SSL 证书未自动配置

**解决方案：**
- 等待 DNS 完全传播
- 在 Vercel 中手动触发证书申请（Settings → Domains → 点击域名 → 重新验证）

### 问题 4: 网站显示 "Not Found" 或 404

**解决方案：**
- 确认项目已成功部署到 Vercel
- 检查 Vercel 项目设置中的构建配置
- 查看 Vercel 部署日志

## 完成检查清单

- [ ] 域名已添加到 Vercel 项目
- [ ] DNS 记录已正确配置
- [ ] DNS 传播已完成（使用工具验证）
- [ ] Vercel 显示域名状态为 "Valid"
- [ ] 可以通过 `https://www.arenafi.org` 访问网站
- [ ] SSL 证书已自动配置（浏览器显示锁图标）
- [ ] 环境变量 `NEXT_PUBLIC_APP_URL` 已更新
- [ ] 应用已重新部署以应用新的环境变量

## 额外建议

1. **设置域名重定向**：确保 `arenafi.org` 重定向到 `www.arenafi.org`（Vercel 会自动处理）

2. **配置邮件域名**：如果使用 Supabase 发送邮件，可能需要配置 SPF/DKIM 记录（参考 `docs/SUPABASE_EMAIL_CONFIG.md`）

3. **监控域名状态**：定期检查 Vercel 中的域名状态，确保一切正常

4. **备份 DNS 配置**：记录您的 DNS 配置，以便将来参考

---

配置完成后，您的网站就可以通过 `www.arenafi.org` 访问了！🎉

