# Vercel 部署指南

## 自动部署（推荐）

如果您的Vercel项目已连接到GitHub仓库，推送代码到`main`分支会自动触发部署。

### 检查自动部署状态

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 选择您的项目
3. 查看"Deployments"标签页

## 手动部署

### 方法1: 使用Vercel Token（CI/CD推荐）

1. 获取Vercel Token:
   - 访问 https://vercel.com/account/tokens
   - 创建新的Token

2. 使用Token部署:
   ```bash
   VERCEL_TOKEN=your_token npx vercel deploy --prod
   ```

   或使用部署脚本:
   ```bash
   VERCEL_TOKEN=your_token ./scripts/deploy-vercel.sh
   ```

### 方法2: 使用部署钩子

1. 在Vercel Dashboard中创建部署钩子:
   - 进入项目设置
   - 选择"Deploy Hooks"
   - 创建新的钩子

2. 使用钩子部署:
   ```bash
   VERCEL_DEPLOY_HOOK_URL=your_hook_url ./scripts/deploy-vercel.sh
   ```

   或直接使用curl:
   ```bash
   curl -X POST your_hook_url
   ```

### 方法3: 交互式登录（本地开发）

```bash
npx vercel login
npx vercel deploy --prod
```

## GitHub Actions自动部署

项目已配置GitHub Actions工作流（`.github/workflows/deploy.yml`），需要设置以下Secret:

1. 在GitHub仓库设置中添加Secret:
   - 进入 Settings -> Secrets and variables -> Actions
   - 添加 `VERCEL_TOKEN`

2. 推送代码到`main`分支会自动触发部署

## 验证部署

部署成功后，您可以:

1. 在Vercel Dashboard查看部署状态
2. 访问部署URL验证功能
3. 查看部署日志排查问题

## 故障排除

### 构建失败

- 检查构建日志中的错误信息
- 确保所有环境变量已正确配置
- 验证`package.json`中的依赖版本

### 认证失败

- 确认Token未过期
- 检查Token权限是否足够
- 尝试重新生成Token

### 环境变量问题

- 在Vercel Dashboard中检查环境变量配置
- 确保生产环境变量已设置
- 验证变量名称和值是否正确
