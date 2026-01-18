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

```bash
cp .env.example .env
# 编辑 .env 填入 Supabase 配置
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

### Railway

1. 创建 Railway 项目
2. 连接 GitHub 仓库
3. 设置 Root Directory 为 `worker`
4. 添加环境变量
5. 设置 Cron Job（每 2 小时）

### 自建服务器

使用 cron 或 systemd timer 定时执行：

```bash
# crontab -e
0 */2 * * * cd /path/to/worker && npm run scrape:all >> /var/log/arena-worker.log 2>&1
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
│       ├── base.ts     # 爬虫基类
│       ├── binance-spot.ts
│       └── index.ts
├── package.json
└── tsconfig.json
```

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
