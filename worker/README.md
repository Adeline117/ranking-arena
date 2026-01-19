# Arena Worker

独立的数据抓取服务，用于从各交易所获取排行榜数据。

## 为什么需要独立 Worker？

Vercel Serverless Functions 有 60 秒的执行超时限制，而数据抓取任务需要：
- 启动浏览器
- 加载页面
- 模拟用户交互
- 分页获取数据

这些操作通常需要 2-5 分钟，因此需要在独立服务中运行。

## 快速开始

### 1. 安装依赖

```bash
cd worker
npm install
npx playwright install chromium
```

### 2. 配置环境变量

创建 `.env` 文件并填入以下配置：

```bash
# Supabase 配置 (必需)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# 告警通知 (可选)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/xxx/xxx
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/xxx

# 代理池配置 (可选，用于降低被封风险)
# 格式: server|username|password,server2|username2|password2
# 简单格式 (无认证): http://proxy1:port,http://proxy2:port
PROXY_LIST=http://proxy1.example.com:8080,http://proxy2.example.com:8080

# 日志级别 (可选)
LOG_LEVEL=info
```

### 3. 运行

```bash
# 开发模式（监听文件变化）
npm run dev

# 抓取所有数据源
npm run scrape:all

# 抓取指定数据源
npm run scrape:binance
```

## CLI 使用

```bash
# 抓取所有数据源和时间段
tsx src/cli.ts scrape --all

# 抓取指定数据源
tsx src/cli.ts scrape --source binance_spot

# 抓取指定数据源和时间段
tsx src/cli.ts scrape --source binance_spot --time 90D
```

## 部署选项

### Railway (推荐)

Railway 是一个简单易用的云平台，支持 Docker 部署和 Cron Jobs。

#### 部署步骤

1. **创建 Railway 账号**
   - 访问 [railway.app](https://railway.app)
   - 使用 GitHub 登录

2. **创建新项目**
   - 点击 "New Project"
   - 选择 "Deploy from GitHub repo"
   - 选择你的仓库

3. **配置项目**
   - 在 Settings 中设置 Root Directory 为 `worker`
   - Railway 会自动检测 Dockerfile 并构建

4. **添加环境变量**
   在 Variables 中添加：
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   SLACK_WEBHOOK_URL=https://hooks.slack.com/... (可选)
   PROXY_LIST=http://proxy1:port,http://proxy2:port (可选)
   LOG_LEVEL=info
   ```

5. **配置 Cron Job**
   - 在项目中添加一个新的 Service
   - 选择 "Cron Job"
   - 设置定时表达式: `0 */2 * * *` (每 2 小时)
   - 命令: `npm run scrape:all`

#### 预估成本

- **Starter Plan**: 免费，每月 500 小时
- **Developer Plan**: $5/月，足够运行爬虫服务
- **Team Plan**: $20/月，适合生产环境

### Fly.io (备选)

```bash
# 安装 flyctl
curl -L https://fly.io/install.sh | sh

# 登录
fly auth login

# 创建应用
fly apps create arena-worker

# 设置环境变量
fly secrets set SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx

# 部署
fly deploy
```

### 自建服务器

使用 cron 或 systemd timer 定时执行：

```bash
# crontab -e
# 每 2 小时执行一次
0 */2 * * * cd /path/to/worker && npm run scrape:all >> /var/log/arena-worker.log 2>&1

# 或者分别抓取各平台 (推荐，避免超时)
0 0 * * * cd /path/to/worker && npm run scrape:binance >> /var/log/arena-worker.log 2>&1
30 0 * * * cd /path/to/worker && npm run scrape:bybit >> /var/log/arena-worker.log 2>&1
```

### Docker 本地运行

```bash
# 构建镜像
docker build -t arena-worker .

# 运行容器
docker run --rm \
  -e SUPABASE_URL=xxx \
  -e SUPABASE_SERVICE_ROLE_KEY=xxx \
  arena-worker
```

## 架构

```
worker/
├── src/
│   ├── index.ts        # 主入口
│   ├── cli.ts          # CLI 工具
│   ├── db.ts           # Supabase 客户端
│   ├── logger.ts       # 日志模块
│   ├── types.ts        # 类型定义
│   └── scrapers/
│       ├── base.ts          # 爬虫基类 (含代理池支持)
│       ├── binance-spot.ts  # Binance 现货
│       ├── binance-futures.ts # Binance 合约
│       ├── bybit.ts         # Bybit
│       └── index.ts         # 爬虫注册
├── Dockerfile          # Docker 镜像配置
├── railway.json        # Railway 部署配置
├── package.json
└── tsconfig.json
```

### 代理池功能

爬虫支持代理池轮换，降低被封风险：

- 从环境变量 `PROXY_LIST` 自动加载代理
- 自动轮换代理
- 失败代理自动标记并跳过
- 支持认证代理

格式: `server|username|password,server2|username2|password2`

## 添加新的数据源

1. 在 `src/scrapers/` 创建新的爬虫类，继承 `BaseScraper`
2. 实现 `scrapeData()` 方法
3. 在 `src/scrapers/index.ts` 注册新爬虫
4. 在 `src/types.ts` 添加数据源类型

示例：

```typescript
import { BaseScraper, parseTraderFromApi } from './base.js'
import type { TraderData, TimeRange } from '../types.js'

export class BybitScraper extends BaseScraper {
  constructor() {
    super('bybit')
  }

  protected async scrapeData(timeRange: TimeRange): Promise<TraderData[]> {
    // 实现抓取逻辑
  }
}
```
