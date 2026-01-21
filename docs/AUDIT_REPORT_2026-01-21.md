# 状态与API全面审计报告

**日期:** 2026-01-21
**审计范围:** 状态管理、API契约、并发处理、可观测性

---

## 一、状态时间线审计

### 1.1 排行榜交易员数据状态

**状态来源:**
- `lib/stores/index.ts:35` → `useRankingStore` (未使用)
- `app/components/Home/hooks/useTraderData.ts:26` → `useState<Trader[]>` (实际使用)

**修改路径:**
```
Step 1: 用户访问首页
       ↓
Step 2: useTraderData Hook 初始化 (line 31-39)
       → 从 localStorage 读取 timeRange
       ↓
Step 3: loadCurrentData() 调用 (line 71-84)
       → 调用 /api/traders?timeRange=xxx
       ↓
Step 4: API 返回数据 (route.ts:330-337)
       → { traders, timeRange, totalCount, lastUpdated }
       ↓
Step 5: setCurrentTraders(cached.traders) (line 75)
       → 状态更新
       ↓
Step 6: 静默刷新 (line 99-110)
       → 每 10 分钟后台更新
       ↓
Step 7: 时间段切换 (line 114-116)
       → 触发重新加载
```

**状态丢失点:**
- `useTraderData.ts:44-46`: useRef 缓存页面刷新即清空
- `useTraderData.ts:64-66`: API 失败时无持久化

### 1.2 用户关注状态

**修改路径:**
```
Step 1: 组件挂载 → useState(initialFollowing)
Step 2: useEffect 检查实际状态 → GET /api/follow
Step 3: 用户点击 → 乐观更新 + POST /api/follow
Step 4: API 响应 → 成功确认 / 失败回滚
```

**状态丢失点:**
- 多窗口操作时状态不同步

---

## 二、真实性验证

### 2.1 排行榜数据

| 步骤 | 验证结果 | 位置 |
|------|----------|------|
| 前端显示 | ✅ | RankingTable.tsx |
| API 返回 | ⚠️ 陈旧数据无标识 | route.ts:134-149 |
| 数据库 | ✅ | trader_snapshots |
| 刷新后 | ⚠️ 内存缓存清空 | useTraderData.ts |

### 2.2 UI 幻觉位置

1. `route.ts:134-149`: 24小时无新数据时使用陈旧数据但未标记
2. `FollowButton.tsx:107`: 乐观更新后网络失败回滚延迟

---

## 三、API契约问题

### 3.1 字段不一致

| 前端期望 | 后端返回 | 状态 |
|----------|----------|------|
| volume_90d | 未返回 | ❌ |
| avg_buy_90d | 未返回 | ❌ |
| win_rate | 标准化值 | ⚠️ 可能为 null |
| trades_count | trades_count | ⚠️ 可能为 null |

### 3.2 可空性错误

- 后端: `win_rate: number | null`
- 前端: `win_rate?: number`
- 语义不同，处理逻辑不一致

---

## 四、时间相关问题

1. **时区:** `setHours()` 使用本地时区，`toISOString()` 转 UTC
2. **GMX 特殊处理:** 90D 时被排除，用户可能困惑
3. **排序稳定性:** ✅ 多级排序 + ID 字母序

---

## 五、并发问题

### 5.1 有防护

- FollowButton: pendingRef + isLoading

### 5.2 无防护

- PostActions.tsx Action 组件: 快速双击可触发两次

### 5.3 多窗口

- 数据库幂等，但窗口状态不同步

---

## 六、回滚路径

| 功能 | 可关闭 | 方式 | 影响 |
|------|--------|------|------|
| 排行榜 | ✅ | 替换 HomePage | 首页不可用 |
| 关注 | ⚠️ | API 返回 tableNotFound | 通知异常 |
| 社区 | ❌ | 与小组耦合 | 大范围影响 |

---

## 七、用户易踩坑

1. 时间段切换排名剧变 → 用户困惑
2. 数据缺失显示 "—" → 认为质量差
3. 未登录关注跳转 → 用户流失
4. 搜索用假数据 → 结果为空

---

## 八、缺失日志

| 位置 | 问题 |
|------|------|
| useTraderData.ts | 缓存命中无日志 |
| FollowButton.tsx | 失败仅 Toast |
| route.ts | 错误仅 console.error |

---

## 九、发布审核

### 拒绝上线理由

| # | 风险点 | 严重性 | 24h可修复 |
|---|--------|--------|-----------|
| 1 | Zustand 未使用，状态混乱 | 中 | ❌ |
| 2 | volume_90d/avg_buy_90d 未返回 | 高 | ✅ |
| 3 | 陈旧数据无标识 | 中 | ✅ |
| 4 | Action 无防重复点击 | 高 | ✅ |
| 5 | 搜索用假数据 | 高 | ❌ |
| 6 | 多窗口不同步 | 中 | ❌ |
| 7 | 错误无 Sentry | 中 | ✅ |

### 结论: 拒绝上线

---

## 十、紧急修复清单

### P0 (24h内)

1. 删除 RankingTable Trader 接口中未返回的字段
2. 为 Action 组件添加 processingRef 防重复
3. API 错误接入 Sentry

### P1 (1周内)

4. 陈旧数据 API 响应添加 `isStale: boolean`
5. 搜索功能实现真实 API

### P2 (后续)

6. 统一迁移到 Zustand 或完全移除
7. WebSocket 实现多窗口同步
