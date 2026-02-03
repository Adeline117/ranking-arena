# Week 2 Optimization Report

Date: 2026-02-03

## Summary

完成了 3 个主要任务的研究和实现工作：

---

## 任务1: Bybit 抓取方案研究与实现

### 当前状况

**严重程度: 🔴 Critical**

Bybit 使用 Akamai WAF 严格封锁，情况如下：

| 来源 IP | API 端点 | 状态 |
|---------|----------|------|
| 美国住宅 IP | `www.bybit.com/x-api/...` | ❌ Access Denied |
| Cloudflare Worker | `www.bybit.com/x-api/...` | ❌ Access Denied |
| Vercel (美国) | `www.bybit.com/x-api/...` | ❌ Access Denied |
| api.bybit.com | `v5/copytrading/*` | ❌ CloudFront 403 (地区封锁) |

### 尝试的解决方案

1. **直接 API 调用** - 被 Akamai WAF 封锁
2. **Cloudflare Worker 代理** - 被 Akamai 检测并封锁
3. **不同 API 端点** (`api.bybit.com`, `api2.bybit.com`) - 均被封锁

### 实现的改进

- 更新了 `lib/cron/fetchers/bybit.ts`，添加了代理回退机制
- 更新了 `cloudflare-worker/src/index.ts`，修正了 API 端点和参数
- 添加了详细的错误检测和报告

### 推荐方案

| 方案 | 可行性 | 复杂度 | 备注 |
|------|--------|--------|------|
| 住宅代理服务 | ⭐⭐⭐⭐ | 中 | Bright Data, Oxylabs 等，约 $500/月 |
| Vercel SG/JP 部署 | ⭐⭐⭐ | 低 | 可能有效，需测试 |
| 本地浏览器 + ClashX | ⭐⭐⭐⭐⭐ | 低 | 现有方案，需手动/cron |
| 官方 API 合作 | ⭐⭐⭐⭐⭐ | 高 | 最佳长期方案 |

### 短期解决方案

使用 `scripts/import/browser-fix-all.mjs` 通过本地浏览器 + ClashX 代理抓取：

```bash
# 确保 ClashX 代理运行在 127.0.0.1:7890
node scripts/import/browser-fix-all.mjs bybit
```

---

## 任务2: Bitget Auth Token 机制

### 当前状况

**严重程度: 🟠 Warning**

| 端点类型 | 状态 | 备注 |
|----------|------|------|
| V1 公开 API | ❌ 已废弃 | "V1 API has been decommissioned" |
| V2 公开 API | ❌ 404 | 端点不存在 |
| V2 Broker API | ✅ 可用 | 需要 `BITGET_API_KEY/SECRET/PASSPHRASE` |
| 网页端点 | ❌ CF 保护 | Cloudflare JS Challenge |

### 研究发现

1. **Bitget V2 API 认证要求**:
   - 需要 Broker 账户申请 API Key
   - 签名算法: HMAC-SHA256
   - 签名内容: `timestamp + method + path + body`
   - Headers: `ACCESS-KEY`, `ACCESS-SIGN`, `ACCESS-TIMESTAMP`, `ACCESS-PASSPHRASE`

2. **已实现的认证逻辑** (`lib/cron/fetchers/bitget-futures.ts`):
   - `getBitgetCredentials()` - 读取环境变量
   - `signBitgetRequest()` - 生成 HMAC 签名
   - `fetchWithAuth()` - 认证请求

### 获取 Bitget API Key

1. 申请 Bitget Broker 账户: https://www.bitget.com/broker
2. 获取 API Key 后设置环境变量:
   ```bash
   BITGET_API_KEY=your_api_key
   BITGET_API_SECRET=your_api_secret
   BITGET_API_PASSPHRASE=your_passphrase
   ```
3. 在 Vercel 环境变量中配置

### 备选方案

- 使用 `scripts/import/browser-fix-all.mjs bitget` 进行浏览器抓取

---

## 任务3: 数据新鲜度前端指示器 ✅

### 实现内容

1. **新建 Hook**: `lib/hooks/useDataFreshness.ts`
   - 调用 `/api/monitoring/freshness` API
   - 5 分钟自动刷新
   - 提供平台状态和整体健康度

2. **新建组件**: `app/components/ranking/DataFreshnessIndicator.tsx`
   - 显示数据健康状态图标（✓/⚠️/✕）
   - 点击展开详细平台列表
   - 显示每个平台的:
     - 最后更新时间
     - 数据条数
     - 健康状态（healthy/warning/critical/no_data）
   - 支持中英文

3. **集成到排行榜页面**: `app/rankings/page.tsx`
   - 在标题栏右侧显示
   - 响应式设计

### 功能特点

- 实时显示数据新鲜度
- 过期数据有视觉警告
- 点击查看详情面板
- 链接到完整监控报告

---

## 文件变更清单

### 新增文件

- `lib/hooks/useDataFreshness.ts` - 数据新鲜度 Hook
- `app/components/ranking/DataFreshnessIndicator.tsx` - 新鲜度指示器组件
- `WEEK2_OPTIMIZATION_REPORT.md` - 本报告

### 修改文件

- `lib/cron/fetchers/bybit.ts` - 添加代理回退机制
- `lib/cron/fetchers/bitget-futures.ts` - 添加代理支持
- `cloudflare-worker/src/index.ts` - 修正 Bybit/Bitget 端点
- `app/rankings/page.tsx` - 集成 DataFreshnessIndicator

---

## 下一步行动

### 优先级 P0 (本周)

1. [ ] 申请 Bitget Broker API Key
2. [ ] 测试 Vercel SG/JP region 部署
3. [ ] 设置本地 cron 定时运行 `browser-fix-all.mjs`

### 优先级 P1 (下周)

1. [ ] 评估住宅代理服务
2. [ ] 研究 Bybit 官方 API 合作方案
3. [ ] 添加数据新鲜度告警（Telegram/Slack）

---

*Report generated: 2026-02-03*
