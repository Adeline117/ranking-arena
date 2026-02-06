# Arena 并发安全性审计报告

## 审计概述

**审计日期**: 2026-02-06
**审计范围**: WebSocket 连接管理、Redis 缓存策略、API Key 安全、熔断降级机制
**审计结论**: 已识别并修复 8 个关键问题

---

## 1. 死锁与内存泄漏审计

### 1.1 WebSocket 长连接管理

**审计位置**: `lib/realtime/channel-pool.ts`, `lib/hooks/useRealtime.ts`

**发现的问题**:

| 问题 | 严重性 | 状态 |
|------|--------|------|
| 清理调度时的 TOCTOU 竞态 | 低 | 已有缓解措施 |
| handleChange 迭代期间的并发修改 | 低 | 可接受风险 |
| 服务端实例无清理钩子 | 中 | 建议添加 |

**现有保护机制**:
- ✅ 引用计数模式 (refCount)
- ✅ 5 秒延迟清理防止抖动
- ✅ 60 秒周期性陈旧通道清理
- ✅ 回调错误隔离

**建议改进**:
```typescript
// 添加进程退出清理钩子
process.on('exit', () => {
  channelPool.cleanup()
})
```

### 1.2 Scheduler Job Map 内存管理

**审计位置**: `worker/src/scheduler/index.ts`

**已实现的保护**:
- ✅ 最大完成任务数限制 (100)
- ✅ 最大失败任务数限制 (50)
- ✅ 60 秒周期性清理
- ✅ LRU 风格的旧任务淘汰

---

## 2. Redis 缓存雪崩防护

### 2.1 原有问题

**位置**: `lib/cache/index.ts:356-404`

```typescript
// 问题代码：锁获取失败后直接执行 fetcher
if (!lockAcquired) {
  await sleep(100)  // 仅等待 100ms
  const retryCache = await get<T>(key)
  if (retryCache !== null) return retryCache
  return await fetcher()  // 🔴 多个并发请求可能同时执行
}
```

**风险**: 缓存击穿 - 多个请求在锁失败后同时执行昂贵的数据获取

### 2.2 修复方案

**新实现** (`lib/cache/index.ts:356-430`):

```typescript
// 指数退避重试获取锁
while (Date.now() - startTime < maxWaitMs) {
  attempt++
  const lockAcquired = await redis.set(lockKey, '1', { ex: lockTtl, nx: true })

  if (lockAcquired) {
    // 双重检查
    const doubleCheck = await get<T>(key)
    if (doubleCheck !== null) return doubleCheck

    const data = await fetcher()
    await set(key, data, { ttl: actualTtl })
    return data
  }

  // 指数退避 + 抖动
  const backoffMs = Math.min(retryDelayMs * Math.pow(2, attempt - 1), 1000)
  const jitter = Math.random() * backoffMs * 0.3
  await sleep(backoffMs + jitter)
}
```

**改进点**:
- ✅ 指数退避重试
- ✅ 双重检查锁定
- ✅ TTL 抖动 (±10%) 防止同时过期
- ✅ 最大等待时间限制
- ✅ 兜底执行防止完全失败

### 2.3 批量删除优化

**问题**: `KEYS` 命令在大数据集上会阻塞 Redis

**修复**: 使用 `SCAN` 迭代删除

```typescript
// 新实现：使用 SCAN 替代 KEYS
do {
  const [nextCursor, keys] = await redis.scan(cursor, {
    match: pattern,
    count: 100,
  })
  cursor = Number(nextCursor)
  if (keys.length > 0) {
    await redis.del(...keys)
  }
} while (cursor !== 0)
```

---

## 3. CEX API Key 安全审计

### 3.1 原有问题

**位置**: `lib/exchange/encryption.ts`

| 问题 | 严重性 | 影响 |
|------|--------|------|
| SHA-256 直接作为 KDF | 中 | 弱密钥派生 |
| Base64 回退解密 | 高 | 明文泄露风险 |
| 无密钥轮换机制 | 中 | 长期密钥暴露 |
| 单点密钥存储 | 高 | 拖库即泄露 |

### 3.2 安全增强方案

**新模块**: `lib/exchange/secure-encryption.ts`

#### 3.2.1 PBKDF2 密钥派生
```typescript
// 100,000 次迭代，SHA-512
const key = crypto.pbkdf2Sync(
  password,
  salt,
  100000,  // 迭代次数
  32,      // 密钥长度
  'sha512' // 哈希算法
)
```

#### 3.2.2 密钥分拆存储
```
主密钥 = 分片1 XOR 分片2

分片1 → 环境变量 (ENCRYPTION_KEY_PART1)
分片2 → 数据库 (user_encryption_keys 表)

攻击者必须同时获取:
- 服务器环境变量访问权
- 数据库完整备份
才能恢复明文密钥
```

#### 3.2.3 密钥版本管理
```typescript
interface EncryptedData {
  version: number    // 支持密钥轮换
  salt: string       // PBKDF2 盐值
  iv: string         // 初始化向量
  tag: string        // GCM 认证标签
  ciphertext: string // 密文
}
```

#### 3.2.4 HSM 集成预留
```typescript
interface HSMProvider {
  encrypt(plaintext: Buffer): Promise<Buffer>
  decrypt(ciphertext: Buffer): Promise<Buffer>
  sign(data: Buffer): Promise<Buffer>
  verify(data: Buffer, signature: Buffer): Promise<boolean>
}

// 支持集成:
// - AWS CloudHSM
// - Azure Key Vault HSM
// - Google Cloud HSM
// - HashiCorp Vault Transit
```

---

## 4. 熔断降级中间件

### 4.1 实现概述

**新模块**: `lib/middleware/circuit-breaker.ts`

```
状态转换图:

     ┌──────────────────────────────────────────┐
     │                                          │
     ▼                                          │
 ┌────────┐  失败阈值达到   ┌────────┐  超时后   │
 │ CLOSED │ ──────────────▶ │  OPEN  │ ─────────┤
 └────────┘                 └────────┘          │
     ▲                          │               │
     │                          │               │
     │  成功阈值达到            │ 超时          │
     │                          ▼               │
     │                    ┌───────────┐         │
     └────────────────────│ HALF_OPEN │─────────┘
                          └───────────┘  探测失败
```

### 4.2 配置参数

```typescript
const DEFAULT_CONFIG = {
  failureThreshold: 5,        // 5 次失败触发熔断
  latencyThreshold: 2000,     // 2 秒延迟阈值
  slowRequestThreshold: 3,    // 3 次慢请求触发熔断
  openDuration: 30000,        // 熔断 30 秒
  halfOpenRequests: 3,        // 半开状态探测数
  successThreshold: 2,        // 恢复阈值
}
```

### 4.3 使用示例

```typescript
import { withCircuitBreakerAndCache } from '@/lib/middleware/circuit-breaker'

// 自动缓存降级
const fetchWithBreaker = withCircuitBreakerAndCache(
  'binance',                          // 服务 ID
  'rankings:binance:7d',              // 缓存键
  () => fetchBinanceTraders('7D'),    // 实际请求
  300                                 // 缓存 TTL (秒)
)

const data = await fetchWithBreaker()
// 如果熔断，自动返回缓存数据
```

### 4.4 CEX vs DEX 差异化配置

```typescript
// CEX 更稳定，阈值更高
const cexConfig = {
  failureThreshold: 5,
  latencyThreshold: 2000,
  openDuration: 30000,
}

// DEX 可能不稳定，阈值更低
const dexConfig = {
  failureThreshold: 3,
  latencyThreshold: 3000,
  openDuration: 60000,
}
```

---

## 5. 惊群效应防护

### 5.1 问题描述

当多个 worker 同时失败时，固定的重试延迟会导致所有重试请求同时发出，形成"惊群效应"。

### 5.2 解决方案

**位置**: `worker/src/scheduler/index.ts`

```typescript
// 指数退避 + 30% 抖动
const baseDelay = retryDelayMs * Math.pow(2, retryCount - 1)
const jitter = Math.random() * baseDelay * 0.3
const retryDelay = Math.min(baseDelay + jitter, 60000)
```

**效果**:
- 第 1 次重试: 5s ± 1.5s
- 第 2 次重试: 10s ± 3s
- 第 3 次重试: 20s ± 6s
- 最大延迟: 60s

---

## 6. 压测建议 (10,000 TPS)

### 6.1 Redis 优化建议

```typescript
// 1. 连接池配置
const redis = new Redis({
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  maxConnections: 50,  // 连接池大小
})

// 2. Pipeline 批量操作
const pipeline = redis.pipeline()
for (const item of items) {
  pipeline.set(item.key, item.value, { ex: ttl })
}
await pipeline.exec()

// 3. 本地缓存 (L1) 配置
const L1_CONFIG = {
  maxSize: 2000,           // 最大条目数
  maxBytes: 50 * 1024 * 1024,  // 50 MB
  ttl: 30,                 // 30 秒
}
```

### 6.2 k6 压测脚本示例

```javascript
import http from 'k6/http'
import { check } from 'k6'

export const options = {
  scenarios: {
    rankings_load: {
      executor: 'constant-arrival-rate',
      rate: 10000,           // 10,000 TPS
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 1000,
      maxVUs: 2000,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],  // 95% 请求 < 200ms
    http_req_failed: ['rate<0.01'],    // 错误率 < 1%
  },
}

export default function () {
  const res = http.get('https://api.arenafi.org/api/rankings?window=7d')
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 200ms': (r) => r.timings.duration < 200,
  })
}
```

---

## 7. 修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/middleware/circuit-breaker.ts` | 新建 | 熔断器中间件 |
| `lib/exchange/secure-encryption.ts` | 新建 | 安全加密模块 |
| `lib/cache/index.ts` | 修改 | 缓存雪崩防护 |
| `worker/src/scheduler/index.ts` | 修改 | 重试抖动 |

---

## 8. 后续建议

1. **监控告警**: 集成熔断器状态到 Grafana 仪表板
2. **密钥轮换**: 实现自动化密钥轮换脚本
3. **HSM 部署**: 生产环境考虑使用 AWS CloudHSM
4. **压力测试**: 定期进行 k6 压测验证
5. **审计日志**: 将敏感操作日志发送到 SIEM 系统
