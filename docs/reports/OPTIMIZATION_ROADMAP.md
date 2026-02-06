# 🗺️ Ranking Arena 优化路线图

**规划日期**: 2026-02-06  
**规划者**: Clawd (首席架构师)

---

## 📊 现状分析

### 数据覆盖
| 状态 | 平台数 | 比例 |
|------|--------|------|
| ✅ 健康 (<6h) | 10 | 31% |
| ⚠️ 过期 (>24h) | 10 | 31% |
| ❌ 无数据 | 12 | 38% |

### 技术栈
- **前端**: Next.js 16 + React 19 + TypeScript
- **后端**: Supabase (Postgres + Realtime)
- **部署**: Vercel (Serverless)
- **Web3**: RainbowKit + wagmi + viem + Base

### 关键瓶颈
1. **Vercel Cron 架构问题** - `child_process` 在 serverless 失效
2. **Geo-blocking** - Binance/Bybit/dYdX 需要代理
3. **数据完整性** - 部分平台缺 ROI/WinRate/Drawdown

---

## 🎯 优化计划 (按优先级)

## Phase 1: 数据可靠性 (Week 1)
**目标**: 确保核心数据 24h 内更新

### 1.1 重构 Cron 架构
```
当前问题: Vercel Cron → child_process → FAIL
解决方案: 改为 inline API route + Edge Runtime
```

**任务清单:**
- [ ] 将 `scripts/import/*.mjs` 逻辑迁移到 `app/api/cron/[platform]/route.ts`
- [ ] 每个平台独立 Edge Function (避免 10s 超时)
- [ ] 添加 Upstash QStash 作为可靠 Cron 触发器
- [ ] 实现 waterfall 调度 (避免并发超限)

**预估工时**: 8h

### 1.2 数据源修复
| 平台 | 问题 | 解决方案 | 优先级 |
|------|------|----------|--------|
| Bybit | WAF 封锁 | 海外 VPS + 代理 | P0 |
| Bitget | 需 Auth Token | 研究 Cookie 获取 | P1 |
| dYdX | Geo-block | 使用 Chain API 替代 | P1 |
| KuCoin | SSR/WebSocket | 浏览器 CDP 拦截 | P2 |

**预估工时**: 12h

---

## Phase 2: 性能优化 (Week 2)
**目标**: 首屏 < 1.5s, 交互 < 100ms

### 2.1 前端性能
- [ ] **ISR 预渲染** - 排行榜页面使用 `revalidate: 300`
- [ ] **图片优化** - 头像懒加载 + WebP/AVIF
- [ ] **Bundle 分析** - 移除未使用依赖
- [ ] **React Compiler** - 启用自动 memo

```typescript
// next.config.ts
experimental: {
  reactCompiler: true,
  ppr: true, // Partial Prerendering
}
```

### 2.2 后端性能
- [ ] **Redis 缓存** - 热门查询缓存 5 分钟
- [ ] **数据库索引** - 审计慢查询, 添加复合索引
- [ ] **连接池** - Supabase connection pooling

```sql
-- 添加常用查询索引
CREATE INDEX CONCURRENTLY idx_snapshots_score_desc 
ON trader_snapshots (season_id, arena_score DESC NULLS LAST)
WHERE arena_score IS NOT NULL;
```

**预估工时**: 10h

---

## Phase 3: 用户体验 (Week 3)
**目标**: 提升留存率 20%

### 3.1 个性化功能
- [ ] **智能推荐** - 基于用户浏览历史推荐相似交易员
- [ ] **自定义看板** - 用户可创建私人排行榜
- [ ] **对比功能** - 多个交易员并排对比

### 3.2 通知系统
- [ ] **Web Push** - 关注交易员开仓通知
- [ ] **Email Digest** - 每周热门交易员汇总
- [ ] **Telegram Bot** - 实时价格提醒

### 3.3 移动端优化
- [ ] **PWA 增强** - 离线支持 + 安装提示
- [ ] **手势操作** - 左滑关注, 右滑查看详情
- [ ] **Haptic 反馈** - 已实现 ✅

**预估工时**: 16h

---

## Phase 4: Web3 深化 (Week 4)
**目标**: 增加链上交互价值

### 4.1 NFT 功能
- [ ] **交易员卡牌 NFT** - 铸造热门交易员收藏卡
- [ ] **成就徽章** - 链上认证交易成就
- [ ] **排行榜快照 NFT** - 纪念版周榜/月榜

### 4.2 代币经济
- [ ] **积分系统** - 链上积分 (SBT)
- [ ] **质押功能** - 质押获取 Pro 功能
- [ ] **治理投票** - 社区决定新功能

### 4.3 社交图谱
- [ ] **Farcaster 集成** - 链上社交身份
- [ ] **Lens 协议** - 去中心化关注关系
- [ ] **ENS 支持** - 用户名解析

**预估工时**: 20h

---

## Phase 5: 商业化 (Week 5-6)
**目标**: MRR $5000+

### 5.1 Pro 订阅优化
| 功能 | Free | Pro ($9.99/mo) | Elite ($29.99/mo) |
|------|------|----------------|-------------------|
| 排行榜 | 前 50 | 全部 | 全部 |
| 历史数据 | 7 天 | 90 天 | 1 年 |
| API 调用 | 100/天 | 1000/天 | 无限 |
| 实时通知 | ❌ | ✅ | ✅ |
| 私人看板 | ❌ | 3 个 | 无限 |
| 导出 CSV | ❌ | ✅ | ✅ |

### 5.2 B2B 产品
- [ ] **白标方案** - 为交易所提供嵌入式排行榜
- [ ] **API 产品** - 开放数据 API
- [ ] **企业分析** - 定制报告服务

### 5.3 广告位
- [ ] **推广交易员** - 付费置顶
- [ ] **交易所广告** - Banner 位
- [ ] **联盟营销** - 交易所开户返佣

**预估工时**: 24h

---

## 📅 时间线

```
Week 1  [======] Phase 1: 数据可靠性
Week 2  [======] Phase 2: 性能优化
Week 3  [======] Phase 3: 用户体验
Week 4  [======] Phase 4: Web3 深化
Week 5-6 [============] Phase 5: 商业化
```

---

## 🚀 立即执行 (Today)

### 高优先级任务

1. **设置 Upstash QStash**
   ```bash
   npm install @upstash/qstash
   ```
   - 替代 Vercel Cron
   - 支持重试 + 延迟调度

2. **部署海外 VPS**
   - DigitalOcean/Vultr Singapore ($5/mo)
   - 运行 Bybit/Bitget 数据抓取
   - 通过 Webhook 推送到 Supabase

3. **启用 ISR**
   ```typescript
   // app/rankings/page.tsx
   export const revalidate = 300 // 5 分钟
   ```

---

## 📈 成功指标

| 指标 | 当前 | Week 4 目标 | Week 8 目标 |
|------|------|-------------|-------------|
| 数据新鲜度 | 31% | 80% | 95% |
| 首屏加载 | ~3s | <1.5s | <1s |
| DAU | ? | +50% | +100% |
| Pro 转化率 | ? | 3% | 5% |
| MRR | ? | $2000 | $5000 |

---

## 🔧 技术债清理

### 待删除
- `scripts/import/browser-*.mjs` (迁移后)
- `lib/connectors/legacy/`
- 未使用的依赖 (`npx depcheck`)

### 待重构
- `useRankingsV2` → 使用 React Query
- `trader_snapshots` → 分区表 (按 season_id)
- Logger → 统一使用 Pino

---

*路线图将每周五更新*
