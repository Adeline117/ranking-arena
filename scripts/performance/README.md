# 性能优化脚本

本目录包含用于测量和优化 Ranking Arena 性能的工具。

## 📊 LCP 测量脚本（V1 NO-GO 历史边界）

### measure-lcp.mjs

`scripts/performance/measure-lcp.mjs` 是没有当前操作 caller 的 legacy compatibility path。
在 V1 NO-GO 下，它是 source-only tombstone：无论传入何种参数，均只向 stderr 输出
`[RETIRED] scripts/performance/measure-lcp.mjs`，stdout 保持为空，并以 exit `2` 结束。

本节不提供旧脚本的手动运行、目标 URL、依赖安装、CI YAML、浏览器控制或报告上传说明。
该脚本不会解析目标、加载 Lighthouse、访问网络、安装依赖、启动或控制浏览器，也不会生成、读取、
覆盖或上传 Lighthouse 报告。历史命令、CI 配置和报告描述不能用作当前性能测量、发布、部署或外部状态的证据。

这是单一脚本的 source-only boundary：它不改变现有的 Lighthouse CI/workflow、其他性能工具、
Vercel Analytics、Chrome DevTools、已部署浏览器状态或已经生成的报告。任何未来测量、CI 或报告工作
都需要独立的 owner 批准计划和单独证据；本 README 不提供执行步骤。

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
  shouldPrioritizeImage,
} from '@/lib/performance/image-optimization'

// 优化图片 URL
const optimizedSrc = getOptimizedImageUrl(originalSrc, {
  width: 200,
  quality: 85,
  format: 'webp',
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
