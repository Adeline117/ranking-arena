# 🔍 Ranking Arena 上线前全栈审计报告

**审计日期**: 2026-02-06  
**审计员**: Clawd (首席架构师)

---

## 📊 执行摘要

| 类别 | Must-Fix | Nice-to-Have | 状态 |
|------|----------|--------------|------|
| 前端性能 | 2 | 3 | ⚠️ 需关注 |
| 后端瓶颈 | 1 | 2 | ⚠️ 需关注 |
| UI 细节 | 1 | 4 | ✅ 大部分完成 |
| 安全加固 | 0 | 3 | ✅ 基础完善 |
| AML 合规 | 1 | 1 | 🔴 待实施 |

---

## 1️⃣ 前端性能审计

### ✅ 已完成优化
- **VirtualLeaderboard**: 虚拟滚动，只渲染可见行 (>50 traders)
- **DataBuffer**: 300ms 数据缓冲，Delta 增量推送
- **Channel Pool**: WebSocket 连接复用，防止泄漏

### 🔴 Must-Fix

**MF-1: WebSocket 订阅未使用 useMemo 包装依赖**
```tsx
// 问题位置: app/messages/[conversationId]/page.tsx:320
useRealtime<Message>({
  table: 'messages',
  filter: `conversation_id=eq.${conversationId}`, // conversationId 变化会重建订阅
  ...
})
```
**修复**: 使用 `useMemo` 缓存 filter 字符串，或添加依赖检查

**MF-2: TopNav 双重订阅无去重**
```tsx
// 问题位置: app/components/layout/TopNav.tsx:148-190
let notifChannel = supabase.channel(...)
let msgChannel = supabase.channel(...)
// 每次 mount 创建新 channel，无复用
```
**修复**: 使用 `channelPool` 或添加 channel 缓存

### 🟡 Nice-to-Have

**NH-1**: 添加 `React.memo` 到 TraderRow 组件  
**NH-2**: 排行榜数据使用 `useDeferredValue` 延迟渲染  
**NH-3**: 图表组件懒加载 (`next/dynamic`)

---

## 2️⃣ 后端瓶颈审计

### ✅ 已有防护
- **TokenBucket 限流**: 各交易所独立配置 (Binance 1200/min, OKX 300/min)
- **Redis 分布式锁**: Upstash Redis 已配置
- **连接池**: Supabase 连接复用

### 🔴 Must-Fix

**MF-3: 1000 API Key 同时失效场景未处理**
```ts
// 问题: 无批量失效处理，会产生 1000 次独立重试
// 位置: lib/connectors/*.ts

// 需要添加:
// 1. 熔断器 (Circuit Breaker)
// 2. 指数退避 + 抖动
// 3. 批量重试队列
```
**修复方案**:
```ts
// lib/connectors/circuit-breaker.ts
class CircuitBreaker {
  private failures = 0
  private lastFailure = 0
  private state: 'closed' | 'open' | 'half-open' = 'closed'
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > 30000) {
        this.state = 'half-open'
      } else {
        throw new Error('Circuit breaker is open')
      }
    }
    // ...
  }
}
```

### 🟡 Nice-to-Have

**NH-4**: 添加 Redis 消息队列 (BullMQ) 处理批量任务  
**NH-5**: API 响应缓存 (Redis + SWR)

---

## 3️⃣ UI 细节审计

### ✅ 已完成
- **EmptyState 组件**: `app/components/ui/EmptyState.tsx`
- **DataStateWrapper**: 统一 loading/error/empty 处理
- **Skeleton Screens**: `app/components/ui/Skeleton.tsx`
- **Toast 通知**: `app/components/ui/Toast.tsx`
- **MetricTooltip**: 指标公式解释 (新增)

### 🔴 Must-Fix

**MF-4: 部分中文文案不符合 Web3 语境**
```tsx
// 问题位置: app/components/trader/stats/StatsPage.tsx:505
<Text>暂无 {period} 数据</Text>
// 应改为: "该时间段内暂无链上活动记录"

// app/components/ui/DataStateWrapper.tsx:96
{emptyMessage || t('noDataAvailable')}
// 建议添加 Web3 风格文案变体
```

### 🟡 Nice-to-Have

**NH-6**: Empty State 添加引导操作 (Connect Wallet / Import API)  
**NH-7**: 错误 Toast 添加 Tx Hash 链接 (链上错误时)  
**NH-8**: Skeleton 添加 shimmer 动画  
**NH-9**: 加载状态添加预估时间

---

## 4️⃣ 安全加固审计

### ✅ 已实施
- **HTTPS/HSTS**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- **CSP**: 完整配置，限制 script/style/img 来源
- **X-Frame-Options**: DENY (防点击劫持)
- **X-Content-Type-Options**: nosniff
- **CORS**: 同源策略

### 🟡 Nice-to-Have

**NH-10: API Key 内存清理**
```ts
// 当前: API Key 在请求完成后仍在内存中
// 建议: 使用 WeakRef 或手动清理

// lib/exchange/binance.ts
async function makeRequest(config: BinanceConfig) {
  try {
    // ... 使用 config.apiKey
  } finally {
    // 清理敏感数据
    config.apiKey = ''
    config.secretKey = ''
  }
}
```

**NH-11: 添加 Rate Limit 响应头**
```ts
// 返回剩余配额，帮助客户端自适应
headers.set('X-RateLimit-Remaining', remaining.toString())
headers.set('X-RateLimit-Reset', resetTime.toString())
```

**NH-12: 审计日志**
```ts
// 记录所有 API Key 操作
await auditLog({
  action: 'api_key_used',
  exchange: 'binance',
  timestamp: new Date(),
  ip: request.ip,
})
```

---

## 5️⃣ AML 合规审计

### 🔴 Must-Fix

**MF-5: 未接入制裁地址检查**
```ts
// 建议: 接入 Chainalysis 或 TRM Labs API
// 在用户绑定钱包/API 时检查

// lib/compliance/aml-check.ts
import { ChainalysisClient } from '@chainalysis/api'

export async function checkSanctionedAddress(address: string): Promise<boolean> {
  const client = new ChainalysisClient(process.env.CHAINALYSIS_API_KEY)
  const result = await client.screening.check(address)
  
  if (result.isSanctioned) {
    await notifyCompliance({
      address,
      reason: result.sanctionPrograms,
      timestamp: new Date(),
    })
    return true
  }
  return false
}

// 使用位置: 
// - 钱包连接时 (WalletSection.tsx)
// - API Key 绑定时 (ExchangeConnection.tsx)
```

### 🟡 Nice-to-Have

**NH-13**: 交易监控 - 检测异常大额转账  
**NH-14**: 用户风险评分 (基于链上行为)

---

## 📋 修复优先级清单

### 🔴 Must-Fix (上线前必须)

| ID | 问题 | 位置 | 工时估计 |
|----|------|------|----------|
| MF-1 | WebSocket 依赖重建 | messages/page.tsx | 1h |
| MF-2 | TopNav 双重订阅 | TopNav.tsx | 2h |
| MF-3 | 熔断器机制 | lib/connectors/ | 4h |
| MF-4 | Web3 文案优化 | i18n/ | 2h |
| MF-5 | AML 制裁检查 | lib/compliance/ | 8h |

**总工时**: ~17h

### 🟡 Nice-to-Have (上线后迭代)

| ID | 优化项 | 优先级 |
|----|--------|--------|
| NH-1 | TraderRow memo | P1 |
| NH-4 | BullMQ 队列 | P1 |
| NH-10 | API Key 内存清理 | P1 |
| NH-6 | Empty State 引导 | P2 |
| NH-7 | Tx Hash Toast | P2 |
| NH-12 | 审计日志 | P2 |
| NH-13 | 交易监控 | P3 |

---

## 🚀 建议上线流程

1. **Week 1**: 完成 MF-1, MF-2, MF-4 (前端+文案)
2. **Week 2**: 完成 MF-3 (熔断器)
3. **Week 3**: 完成 MF-5 (AML 集成)
4. **Week 4**: 灰度发布 + 监控

---

*审计完成时间: 2026-02-06 05:45 PST*
