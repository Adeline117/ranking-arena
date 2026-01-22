# i18n 硬编码审计报告

审计日期: 2026-01-21

## 概述

扫描了 `app/components/` 目录下的 `.tsx` 文件，发现以下硬编码中文字符串。

---

## 高优先级修复（用户可见的 UI 文本）

### 1. `app/components/home/StatsBar.tsx`

```typescript
// Line 176-198
label: '活跃交易员',
label: '平均 ROI',
label: '最佳表现',
label: '数据源',
```

**建议**: 使用 `t('home.stats.activeTraders')` 等

---

### 2. `app/components/home/MarketPanel.tsx`

```typescript
// Line 141, 146
setError('请求超时，请稍后重试')
setError('网络连接失败，请检查网络设置')
```

**建议**: 使用 `t('errors.timeout')`, `t('errors.networkError')`

---

### 3. `app/components/post/PostFeed.tsx`

```typescript
// Line 375, 397, 496, 499, 1050, 1175, 1675, 1921, 2031
'获取帖子失败'
'加载失败'
'无标题'
'匿名'
'删除评论'
'确定要删除这条评论吗？'
'删除帖子'
'确定要删除这篇帖子吗？删除后无法恢复。'
'小组'
'取消置顶' / '置顶'
'转发自'
```

**建议**: 迁移到 i18n

---

### 4. `app/components/charts/Sparkline.tsx`

```typescript
// Line 183, 201, 205, 327
aria-label={ariaLabel || '暂无数据'}
return '数据不足'
return `趋势${change >= 0 ? '上涨' : '下跌'} ${Math.abs(change).toFixed(1)}%`
aria-label={`${isPositive ? '上涨' : isNegative ? '下跌' : '持平'} ${Math.abs(change).toFixed(1)}%`}
```

**建议**: 使用 `t('chart.noData')`, `t('chart.trend.up')` 等

---

### 5. `app/components/layout/TopNav.tsx`

```typescript
// Line 264, 442, 516, 544, 597, 628, 660, 784
aria-label="返回首页"
aria-label="搜索交易员"
aria-label="搜索"
aria-label="通知"
aria-label="用户菜单"
alt="头像"
aria-label="用户菜单选项"
<span>私信</span>
```

**建议**: aria-label 也应该国际化

---

## 中优先级（可接受但建议修复）

### 6. `app/components/groups/PremiumGroupCard.tsx`

```typescript
// Line 161, 164, 169
// 这里已经有条件判断，但可以更优雅
language === 'en' ? 'Trial' : '试用中'
language === 'en' ? 'Expires:' : '到期：'
language === 'en' ? 'Manage' : '管理订阅'
```

**建议**: 使用 `t()` 函数统一处理

---

## 低优先级（不影响用户体验）

### 注释中的中文

以下文件包含中文注释，不影响运行但建议保持一致：

- `app/components/Providers/AnalyticsProvider.tsx` - JSDoc 注释
- `app/components/base/Button.tsx` - 内联注释
- `app/components/base/OptimizedImage.tsx` - JSDoc 注释
- `app/components/charts/*.tsx` - JSDoc 注释

**建议**: 保持注释语言一致（中文或英文），不作为硬编码问题处理。

---

## 修复示例

### Before

```tsx
// StatsBar.tsx
const stats = [
  { label: '活跃交易员', value: ... },
  { label: '平均 ROI', value: ... },
]
```

### After

```tsx
// StatsBar.tsx
import { t } from '@/lib/i18n'

const stats = [
  { label: t('home.stats.activeTraders'), value: ... },
  { label: t('home.stats.averageROI'), value: ... },
]

// lib/i18n.ts 添加
'home.stats.activeTraders': { zh: '活跃交易员', en: 'Active Traders' },
'home.stats.averageROI': { zh: '平均 ROI', en: 'Avg ROI' },
```

---

## 建议的 Lint 规则

在 `.eslintrc.js` 中添加规则检测中文字符串：

```javascript
// 自定义规则或使用 eslint-plugin-i18next
rules: {
  // 警告在 JSX 中使用中文字符串
  'no-restricted-syntax': [
    'warn',
    {
      selector: 'JSXText[value=/[一-龥]/]',
      message: '请使用 t() 函数进行国际化'
    }
  ]
}
```

---

## 修复优先级

| 优先级 | 文件 | 硬编码数量 | 建议 |
|--------|------|-----------|------|
| P1 | PostFeed.tsx | 11 | 立即修复 |
| P1 | StatsBar.tsx | 4 | 立即修复 |
| P1 | TopNav.tsx | 8 | 立即修复（aria-label） |
| P2 | Sparkline.tsx | 4 | 下次迭代 |
| P2 | MarketPanel.tsx | 2 | 下次迭代 |
| P3 | PremiumGroupCard.tsx | 3 | 重构时顺带处理 |

---

## 总计

- **高优先级**: 23 处
- **中优先级**: 3 处
- **低优先级**: 注释（不计入）

---

最后更新: 2026-01-21
