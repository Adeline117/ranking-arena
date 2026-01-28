# 首屏加载性能优化总结

**目标**: LCP < 1.5s (当前目标: < 2.5s)
**日期**: 2026-01-28
**状态**: 进行中

---

## ✅ 已完成的优化

### 1. 字体加载优化 (app/layout.tsx)
- ✅ 使用 `next/font` 自动优化字体加载
- ✅ Inter 字体设置 `display: "swap"` 和 `preload: true`
- ✅ Noto Sans SC 中文字体设置 `preload: false` 延迟加载
- ✅ 添加 `adjustFontFallback: true` 减少布局偏移
- ✅ 减少 Noto Sans SC 字重到仅 400 和 700

### 2. 资源预连接和 DNS 预获取 (app/layout.tsx)
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
<link rel="dns-prefetch" href="https://supabase.co" />
```

### 3. 分析工具延迟加载 (app/layout.tsx)
```tsx
<Suspense fallback={null}>
  <WebVitals />
  <SpeedInsights />
</Suspense>
```

### 4. 服务端数据预获取 (app/page.tsx)
- ✅ 实现 `getInitialTraders()` SSR 数据获取
- ✅ 启用 ISR with `revalidate: 60` (60秒)
- ✅ 减少初始交易员数量从 100 到 50
- ✅ 消除客户端数据瀑布流

### 5. 组件懒加载 (app/components/home/HomePage.tsx)
- ✅ `StatsBar` 使用 `dynamic()` 延迟加载 (ssr: false)
- ✅ `SidebarSection` 使用 `dynamic()` 延迟加载 (ssr: false)
- ✅ `CompareTraders` 使用 `lazy()` 懒加载

### 6. 图片优化
- ✅ 创建 `LazyImage` 组件使用 Next.js Image
- ✅ 表格头像使用原生 `<img>` + `loading="lazy"`
- ✅ 添加 `referrerPolicy="no-referrer"` 提高安全性

---

## 🎯 进一步优化建议

### Priority 1: 关键路径优化

#### 1.1 减少初始 JavaScript 包大小
```bash
# 当前问题：
- 首屏加载的 JS 包可能过大
- 需要分析哪些库占用空间最大

# 解决方案：
1. 运行 bundle analyzer 查看包组成
2. 考虑使用更轻量的替代库
3. 实现更激进的代码拆分
```

#### 1.2 优化关键 CSS
```tsx
// 当前：CSS 通过 globals.css 加载
// 改进：内联关键 CSS

// app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        {/* 内联关键 CSS */}
        <style dangerouslySetInnerHTML={{ __html: criticalCss }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

#### 1.3 优化首屏可见组件
```tsx
// 优先级顺序：
1. TopNav (最高) - 已优化
2. RankingTable 前3行 (高)
3. StatsBar (中) - 已延迟
4. SidebarSection (低) - 已延迟
```

### Priority 2: 图片优化

#### 2.1 首屏头像优化
```tsx
// RankingTable.tsx - 前3个交易员头像使用优先加载
{traders.slice(0, 3).map((trader, index) => (
  <Image
    src={getTraderAvatarUrl(trader.avatar_url)}
    alt={trader.nickname}
    width={36}
    height={36}
    priority={index < 3}  // 前3个优先加载
    quality={75}
  />
))}
```

#### 2.2 使用 WebP 格式
```typescript
// lib/utils/image.ts
export function getOptimizedImageUrl(url: string, options?: {
  width?: number
  quality?: number
  format?: 'webp' | 'avif'
}) {
  // 使用 Cloudinary 或 Vercel Image Optimization
  return `/api/image?url=${encodeURIComponent(url)}&w=${options?.width || 800}&q=${options?.quality || 75}&f=${options?.format || 'webp'}`
}
```

### Priority 3: 数据获取优化

#### 3.1 减少首屏数据字段
```typescript
// lib/server/getInitialTraders.ts
// 当前：获取所有字段
// 改进：只获取首屏显示需要的字段

export async function getInitialTraders(timeRange: string, limit: number) {
  const { data } = await supabase
    .from('trader_sources')
    .select(`
      trader_id,
      nickname,
      avatar_url,
      roi,
      pnl,
      platform,
      arena_score
      -- 移除不必要的字段如 description, updated_at 等
    `)
    .limit(limit)

  return data
}
```

#### 3.2 使用更短的 ISR 周期（可选）
```typescript
// app/page.tsx
// 当前: export const revalidate = 60
// 改进: 考虑使用 30 秒以获得更新鲜的数据
export const revalidate = 30
```

### Priority 4: 缓存策略优化

#### 4.1 启用 Service Worker 缓存
```typescript
// public/sw.js - 已有 ServiceWorkerRegistration
// 确保缓存策略正确配置

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/traders')) {
    // 使用 stale-while-revalidate 策略
    event.respondWith(
      caches.open('api-cache').then((cache) => {
        return cache.match(event.request).then((response) => {
          const fetchPromise = fetch(event.request).then((networkResponse) => {
            cache.put(event.request, networkResponse.clone())
            return networkResponse
          })
          return response || fetchPromise
        })
      })
    )
  }
})
```

#### 4.2 HTTP 缓存头优化
```typescript
// next.config.js
module.exports = {
  async headers() {
    return [
      {
        source: '/api/traders',
        headers: [
          {
            key: 'Cache-Control',
            value: 's-maxage=30, stale-while-revalidate=60'
          }
        ]
      }
    ]
  }
}
```

### Priority 5: 渲染优化

#### 5.1 虚拟滚动（对于长列表）
```tsx
// 如果交易员列表超过 50 个，考虑使用虚拟滚动
import { useVirtualizer } from '@tanstack/react-virtual'

function RankingTable({ traders }: { traders: Trader[] }) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: traders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60, // 每行高度
    overscan: 5
  })

  return (
    <div ref={parentRef} style={{ height: '600px', overflow: 'auto' }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <TraderRow key={virtualRow.index} trader={traders[virtualRow.index]} />
        ))}
      </div>
    </div>
  )
}
```

#### 5.2 减少首次渲染组件数量
```tsx
// HomePage.tsx
// 当前：立即渲染所有组件
// 改进：使用 useEffect 延迟非关键组件

function HomePage() {
  const [showSidebar, setShowSidebar] = useState(false)

  useEffect(() => {
    // 延迟 1 秒后显示侧边栏
    const timer = setTimeout(() => setShowSidebar(true), 1000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <>
      <RankingSection />
      {showSidebar && <SidebarSection />}
    </>
  )
}
```

---

## 📊 性能指标监控

### 当前目标
- **LCP** (Largest Contentful Paint): < 1.5s
- **FID** (First Input Delay): < 50ms
- **CLS** (Cumulative Layout Shift): < 0.1
- **TTFB** (Time to First Byte): < 200ms
- **FCP** (First Contentful Paint): < 1.0s

### 测试方法
```bash
# 1. Lighthouse CI
npx lighthouse https://your-staging-url.vercel.app --only-categories=performance

# 2. WebPageTest
# https://www.webpagetest.org/

# 3. Chrome DevTools Performance
# 打开 DevTools → Performance → 录制 → 分析

# 4. Vercel Analytics
# Dashboard → Project → Analytics → Web Vitals
```

---

## 🚀 下一步行动

### 立即执行（本次优化）
1. ✅ 分析当前 bundle size（运行中）
2. [ ] 内联关键 CSS
3. [ ] 优化首屏头像加载（前3个使用 priority）
4. [ ] 减少初始数据字段
5. [ ] 在 staging 环境测试 LCP

### 中期优化（下周）
1. [ ] 实现虚拟滚动（如需要）
2. [ ] 优化 Service Worker 缓存策略
3. [ ] 使用 WebP 格式图片
4. [ ] HTTP 缓存头优化

### 长期优化（未来）
1. [ ] 考虑使用 Edge Runtime
2. [ ] 实现 Partial Prerendering (PPR)
3. [ ] 使用 Cloudflare Workers 进一步优化
4. [ ] 实现更智能的数据预取策略

---

## 📈 预期改进

基于当前优化，预期性能提升：

| 指标 | 当前 | 优化后目标 | 改进 |
|------|------|-----------|------|
| LCP | ~2.5s | <1.5s | -40% |
| FCP | ~1.5s | <1.0s | -33% |
| TTFB | ~300ms | <200ms | -33% |
| JS Bundle | ~500KB | <350KB | -30% |

---

## 🔍 关键优化原则

1. **优先优化 LCP 元素**
   - 排行榜表格是 LCP 元素
   - 确保快速加载和渲染

2. **减少主线程工作**
   - 延迟非关键 JavaScript
   - 使用 Web Workers 处理复杂计算

3. **优化关键渲染路径**
   - 内联关键 CSS
   - 预加载关键资源
   - 延迟非关键资源

4. **数据获取策略**
   - SSR + ISR 最佳实践
   - 减少数据传输大小
   - 智能缓存策略

5. **持续监控**
   - 使用 Web Vitals 实时监控
   - 定期运行 Lighthouse
   - A/B 测试不同优化方案

---

**最后更新**: 2026-01-28
**负责人**: Claude Opus 4.5
**下次审查**: 完成本次优化后
