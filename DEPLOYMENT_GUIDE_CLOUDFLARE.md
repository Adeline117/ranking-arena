# Cloudflare Worker 部署指南

## 快速部署（5分钟）

### 前置条件
- Cloudflare账号
- Node.js已安装
- Wrangler CLI (会自动安装)

### 部署步骤

```bash
cd ~/arena/cloudflare-worker

# 1. 登录Cloudflare
npx wrangler login
# 会打开浏览器，点击"Allow"授权

# 2. 部署Worker
npx wrangler deploy

# 3. 复制输出的URL (类似这样):
# ✨ Success! Uploaded to Cloudflare.
# 🌎 https://ranking-arena-proxy.<YOUR-ACCOUNT>.workers.dev

# 4. 配置环境变量
# 编辑 ~/arena/.env.local，添加:
```

在 `.env.local` 添加：
```env
CLOUDFLARE_PROXY_URL=https://ranking-arena-proxy.<YOUR-ACCOUNT>.workers.dev
```

### 验证部署

```bash
# 测试health endpoint
curl https://ranking-arena-proxy.<YOUR-ACCOUNT>.workers.dev/health

# 应该返回:
# {"status":"ok","timestamp":"2026-03-07T..."}

# 测试Bybit proxy
curl -H "Origin: https://www.arenafi.org" \
  "https://ranking-arena-proxy.<YOUR-ACCOUNT>.workers.dev/bybit/copy-trading"
```

### 已支持的平台

Worker已配置以下proxy endpoints：
- `/bybit/copy-trading` - Bybit多fallback支持
- `/mexc/copy-trading` - MEXC多endpoint自动发现
- `/htx/copy-trading` - HTX + Huobi legacy支持  
- `/proxy?url=<encoded-url>` - 通用proxy

### 部署后任务

1. 测试所有endpoint（运行 `npm run test:platforms`）
2. 监控Worker日志 (`npx wrangler tail`)
3. 检查Worker的Request数量限制（免费版100k/day）

### 故障排除

**问题**: `wrangler login` 卡住  
**解决**: 手动访问 https://dash.cloudflare.com/，生成API token

**问题**: 部署失败 "Route already exists"  
**解决**: 删除旧worker: `npx wrangler delete ranking-arena-proxy`

**问题**: 403 CORS错误  
**解决**: 检查 `wrangler.toml` 中的 `ALLOWED_ORIGINS`

## 部署完成后通知子代理
将Worker URL发送给我，我会自动更新所有connector配置。
