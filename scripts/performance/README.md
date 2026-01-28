# 性能优化脚本

本目录包含用于测量和优化 Ranking Arena 性能的工具。

## 📊 LCP 测量脚本

### measure-lcp.mjs

使用 Lighthouse 测量页面的 LCP (Largest Contentful Paint) 和其他核心 Web Vitals 指标。

**使用方法：**

```bash
# 测量本地开发环境
node scripts/performance/measure-lcp.mjs http://localhost:3000

# 测量 staging 环境
node scripts/performance/measure-lcp.mjs https://your-staging-url.vercel.app

# 测量生产环境
node scripts/performance/measure-lcp.mjs https://www.arenafi.org
```

**输出：**

脚本会输出：
- 总体性能分数 (0-100)
- LCP (目标: < 1.5s)
- CLS (目标: < 0.1)
- FCP, SI, TTI, TBT
- 优化建议（按潜在收益排序）

结果会保存到：
- `.lighthouse-report.json` - 完整 Lighthouse 报告
- `.lighthouse-summary.json` - 性能指标摘要

**退出状态码：**
- `0` - LCP ≤ 2.5s (通过)
- `1` - LCP > 2.5s (需要优化)

### 在 CI/CD 中使用

```yaml
# .github/workflows/performance.yml
name: Performance Check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Start server
        run: npm start &
        env:
          PORT: 3000

      - name: Wait for server
        run: npx wait-on http://localhost:3000

      - name: Run Lighthouse
        run: node scripts/performance/measure-lcp.mjs http://localhost:3000

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: lighthouse-report
          path: .lighthouse-report.json
```

---

## 🎯 性能目标

### Core Web Vitals
- **LCP** (Largest Contentful Paint): < 1.5s
- **FID** (First Input Delay): < 50ms
- **CLS** (Cumulative Layout Shift): < 0.1

### 其他指标
- **FCP** (First Contentful Paint): < 1.0s
- **TTFB** (Time to First Byte): < 200ms
- **SI** (Speed Index): < 2.0s
- **TTI** (Time to Interactive): < 3.0s
- **TBT** (Total Blocking Time): < 150ms

---

## 📈 性能监控

### 本地开发
```bash
# 运行性能测试
npm run perf:test

# 生成性能报告
npm run perf:report
```

### Vercel Analytics
在 Vercel Dashboard 中查看实时性能数据：
1. 进入项目 Dashboard
2. 点击 "Analytics" 标签
3. 查看 "Web Vitals" 部分

### Chrome DevTools
1. 打开 DevTools (F12)
2. 进入 "Performance" 标签
3. 点击录制按钮
4. 刷新页面
5. 停止录制并分析结果

---

## 🛠️ 优化工具

### lib/performance/critical-css.ts
关键 CSS 内联工具，提取首屏必需样式。

```typescript
import { getCriticalCss } from '@/lib/performance/critical-css'

// 在 layout.tsx 中使用
<head>
  <style dangerouslySetInnerHTML={{ __html: getCriticalCss() }} />
</head>
```

### lib/performance/image-optimization.ts
图片优化工具集。

```typescript
import {
  getOptimizedImageUrl,
  getImageLoadingStrategy,
  shouldPrioritizeImage
} from '@/lib/performance/image-optimization'

// 优化图片 URL
const optimizedSrc = getOptimizedImageUrl(originalSrc, {
  width: 200,
  quality: 85,
  format: 'webp'
})

// 获取加载策略
const { loading, priority } = getImageLoadingStrategy(index, 'above')

// 判断是否优先加载
const shouldPriority = shouldPrioritizeImage(index)
```

---

## 📚 相关文档

- [性能优化总结](../../docs/PERFORMANCE_OPTIMIZATION_SUMMARY.md)
- [Web Vitals 指南](https://web.dev/vitals/)
- [Next.js 性能优化](https://nextjs.org/docs/app/building-your-application/optimizing)
- [Lighthouse 文档](https://developers.google.com/web/tools/lighthouse)

---

## 🤝 贡献

发现性能问题或有优化建议？欢迎：
1. 运行性能测试并记录结果
2. 创建 Issue 描述问题
3. 提交 PR 并附上性能对比

---

**最后更新**: 2026-01-28
