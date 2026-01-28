# 性能优化工具实施记录

**日期**: 2026-01-28
**目标**: 应用性能优化工具到实际代码，实现 LCP < 1.5s

---

## ✅ 已实施的优化

### 1. 关键 CSS 内联 (`app/layout.tsx`)

**改动**:
```tsx
// 添加导入
import { getCriticalCss, getResourceHints } from '@/lib/performance/critical-css'

// 在 <head> 中添加
<head>
  {/* Inline critical CSS for faster initial render */}
  <style dangerouslySetInnerHTML={{ __html: getCriticalCss() }} />

  {/* Resource hints for external resources */}
  {getResourceHints().map((hint, index) => (
    <link
      key={`resource-hint-${index}`}
      rel={hint.rel}
      href={hint.href}
      {...(hint.crossOrigin && { crossOrigin: hint.crossOrigin })}
    />
  ))}
</head>
```

**效果**:
- 减少渲染阻塞 CSS
- 首屏样式立即可用
- 更快的首次内容绘制 (FCP)
- 改善累积布局偏移 (CLS)

**预期改进**:
- FCP: -200ms ~ -300ms
- LCP: -100ms ~ -200ms

---

### 2. 图片优化 (`app/components/ranking/RankingTable.tsx`)

**改动**:
```tsx
// 添加导入
import Image from 'next/image'
import {
  getOptimizedImageUrl,
  getImageLoadingStrategy,
  handleImageError,
  IMAGE_PLACEHOLDER,
} from '@/lib/performance/image-optimization'

// 替换原生 <img> 为优化的 Next.js Image
{(() => {
  const proxyAvatarUrl = getTraderAvatarUrl(trader.avatar_url)
  if (!proxyAvatarUrl) return null

  // 根据位置获取加载策略（前3个关键）
  const loadingStrategy = getImageLoadingStrategy(index, 'above')
  const isPriority = index < 3

  return (
    <Image
      src={getOptimizedImageUrl(proxyAvatarUrl, {
        width: 72, // 2x for retina
        quality: 85,
        format: 'webp',
      })}
      alt={displayName}
      width={36}
      height={36}
      priority={isPriority}
      loading={loadingStrategy.loading}
      placeholder="blur"
      blurDataURL={IMAGE_PLACEHOLDER.avatar}
      style={{ ... }}
      onError={handleImageError}
    />
  )
})()}
```

**优化点**:
1. ✅ **WebP 格式** - 减少 30-40% 图片大小
2. ✅ **优先加载** - 前3个头像使用 `priority={true}`
3. ✅ **Retina 支持** - 2x 尺寸确保清晰度
4. ✅ **Blur Placeholder** - 防止布局偏移
5. ✅ **懒加载** - 非关键图片延迟加载
6. ✅ **错误处理** - 优雅降级

**影响范围**:
- 桌面端排行榜表格
- 移动端排行榜卡片
- 所有交易员头像显示

**预期改进**:
- 图片加载时间: -40% ~ -50%
- LCP: -300ms ~ -500ms（如果图片是 LCP 元素）
- CLS: 接近 0（blur placeholder）

---

### 3. 可复用优化头像组件 (`app/components/ui/OptimizedAvatar.tsx`)

创建了一个完全优化的头像组件，供其他地方使用。

**特性**:
- ✅ Next.js Image 自动优化
- ✅ WebP/AVIF 格式支持
- ✅ 优先加载策略（前3个）
- ✅ Blur placeholder
- ✅ Retina 支持（2x）
- ✅ 错误处理和回退
- ✅ 骨架屏组件

**使用方法**:
```tsx
import { OptimizedAvatar } from '@/app/components/ui/OptimizedAvatar'

<OptimizedAvatar
  userId={user.id}
  name={user.name}
  avatarUrl={user.avatar_url}
  size={48}
  priority={index < 3}
  index={index}
/>
```

---

## 📊 性能影响分析

### 首屏加载路径优化

**优化前**:
```
1. HTML 到达
2. 下载外部 CSS (阻塞渲染)
3. 解析 CSS
4. 首次渲染
5. 下载图片
6. LCP (Largest Contentful Paint)
```

**优化后**:
```
1. HTML 到达（包含内联关键 CSS）
2. 立即首次渲染 ✨
3. 前3个图片优先加载（并行）
4. LCP (更快) ⚡
5. 延迟加载非关键资源
```

### 网络优化

**减少请求**:
- 关键 CSS 内联 → 减少 1 个 CSS 请求
- WebP 格式 → 减少 30-40% 图片传输

**并行加载**:
- 资源预连接 → 提前建立连接
- 优先加载策略 → 关键资源优先

### 渲染优化

**减少阻塞**:
- 内联 CSS → 无需等待外部 CSS
- Blur placeholder → 防止布局偏移

**改善用户体验**:
- 更快的首次渲染
- 更少的布局抖动
- 渐进式图片加载

---

## 🎯 预期性能提升

基于这次实施，预期整体性能提升：

| 指标 | 优化前 | 优化后 | 改进 |
|------|--------|--------|------|
| FCP | ~1.5s | ~1.0s | **-33%** |
| LCP | ~2.5s | ~1.5s | **-40%** |
| CLS | ~0.15 | <0.05 | **-67%** |
| 图片大小 | ~100KB | ~60KB | **-40%** |

---

## 🧪 验证步骤

### 本地验证

```bash
# 1. 构建生产版本
npm run build

# 2. 启动生产服务器
npm start

# 3. 运行性能测试
node scripts/performance/measure-lcp.mjs http://localhost:3000
```

### Staging 验证

```bash
# 测试 staging 环境
node scripts/performance/measure-lcp.mjs https://your-staging-url.vercel.app
```

### Chrome DevTools 验证

1. 打开 DevTools (F12)
2. Performance 标签
3. 录制页面加载
4. 检查指标:
   - LCP 元素
   - 图片加载时间
   - CSS 加载方式
   - 布局偏移

---

## 📝 待优化项目

### 高优先级

1. **减少初始 JavaScript 包**
   - 分析 bundle 组成
   - 移除未使用的依赖
   - 更激进的代码拆分

2. **优化其他图片使用**
   - 交易所 Logo
   - 用户头像（其他页面）
   - 背景图片

3. **字体子集化**
   - 只加载使用的字符
   - 减少中文字体大小

### 中优先级

4. **实现虚拟滚动**（如果列表超过 50 项）
   - 使用 @tanstack/react-virtual
   - 减少 DOM 节点数量

5. **Service Worker 优化**
   - 缓存关键资源
   - Stale-while-revalidate 策略

6. **HTTP 缓存头**
   - API 响应缓存
   - 静态资源缓存

### 低优先级

7. **考虑 Edge Runtime**
8. **Partial Prerendering (PPR)**
9. **Cloudflare Workers**

---

## 🔍 监控和持续优化

### 实时监控

**Vercel Analytics**:
- Dashboard → Analytics → Web Vitals
- 监控 LCP, FID, CLS
- 按页面和设备分类

**Chrome DevTools**:
- Lighthouse 定期审计
- Performance 面板分析
- Network 面板检查

### CI/CD 集成

```yaml
# .github/workflows/performance.yml
- name: Run Performance Tests
  run: |
    npm run build
    npm start &
    npx wait-on http://localhost:3000
    node scripts/performance/measure-lcp.mjs http://localhost:3000
```

### 性能预算

设置性能预算，防止性能退化：

```json
{
  "budgets": [
    {
      "resourceSizes": [
        { "resourceType": "script", "budget": 350 },
        { "resourceType": "image", "budget": 200 },
        { "resourceType": "stylesheet", "budget": 50 }
      ]
    }
  ]
}
```

---

## 🎓 学习要点

### 关键优化原则

1. **优先优化关键渲染路径**
   - 内联关键 CSS
   - 优先加载关键资源
   - 延迟非关键资源

2. **优化 LCP 元素**
   - 识别 LCP 元素（通常是主要内容）
   - 确保 LCP 元素优先加载
   - 优化 LCP 元素的资源

3. **防止布局偏移**
   - 使用 placeholder
   - 设置图片尺寸
   - 避免动态插入内容

4. **渐进增强**
   - 首屏关键内容优先
   - 非关键内容延迟
   - 良好的加载状态

### 工具使用

1. **Next.js Image**
   - 自动格式优化（WebP/AVIF）
   - 响应式图片（srcset）
   - 懒加载支持
   - Blur placeholder

2. **Resource Hints**
   - preconnect - 提前建立连接
   - dns-prefetch - 提前 DNS 解析
   - preload - 优先加载资源

3. **关键 CSS 内联**
   - 提取首屏必需样式
   - 内联到 HTML
   - 其余 CSS 延迟加载

---

## 📚 参考资源

- [Web Vitals](https://web.dev/vitals/)
- [Next.js Image Optimization](https://nextjs.org/docs/app/building-your-application/optimizing/images)
- [Critical CSS](https://web.dev/extract-critical-css/)
- [Resource Hints](https://www.w3.org/TR/resource-hints/)
- [Lighthouse Performance Scoring](https://web.dev/performance-scoring/)

---

**最后更新**: 2026-01-28
**实施人员**: Claude Opus 4.5
**状态**: ✅ 已完成基础实施，待验证效果
