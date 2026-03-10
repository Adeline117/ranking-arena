# Arena 手机端全面优化计划

## 现状评估

### 已有基础 ✅
- 底部导航栏 (MobileBottomNav) — 5 tab, 滚动隐藏, 触觉反馈, safe area
- ThreeColumnLayout 响应式 — mobile 单列, tablet 双列, desktop 三列
- MobileSearchOverlay 全屏搜索
- 排行榜表格响应式 — mobile 3列 (Rank|Trader|ROI), 逐步增列
- viewport 正确配置 (notch, safe area, theme color)
- PWA manifest 已配置
- Critical CSS 内联 + 异步加载 responsive.css
- Touch target ≥44px, 16px input 防止 iOS 缩放

### 核心问题 ❌
1. **无 Capacitor/原生壳** — 纯 PWA, 体验不如 native app
2. **手势交互缺失** — 无左右滑、下拉刷新、卡片滑动
3. **Trader Detail 页面过长** — 信息密度高, 移动端需重新组织
4. **图表体验差** — TradingView 图表在小屏上交互困难
5. **社交功能移动端体验弱** — Groups/Posts 页面未针对移动端优化
6. **无离线支持** — Service Worker 未配置
7. **图片未优化** — 无 srcSet, 无 WebP 降级, avatar 未按设备尺寸裁剪
8. **动画缺失** — 页面切换无过渡, 列表无进入动画
9. **Typography 不一致** — 13-14px 正文, 部分地方过小

---

## Phase 1: 核心体验优化 (1-2 周)

### 1.1 下拉刷新 (Pull-to-Refresh)
**优先级: P0 | 影响: 首页 + Trader Detail**

```
位置: app/components/ui/PullToRefresh.tsx
```

- 自定义下拉刷新组件 (不依赖浏览器默认)
- 首页排行榜: 下拉触发 `invalidateQueries(['rankings'])`
- Trader Detail: 下拉触发 `triggerRefresh()`
- 动画: 圆形 spinner + 弹性回弹
- 阈值: 80px 触发, 最大拉伸 150px

### 1.2 Trader Detail 移动端重组
**优先级: P0 | 影响: 核心路径**

当前问题: 信息全部纵向堆叠, 需要滚动很远才能看到关键数据

移动端新布局:
```
┌─────────────────────────┐
│ ← Back    Trader Name  ⋮│  ← 固定顶栏 (滚动后显示)
├─────────────────────────┤
│  [Avatar]               │
│  TraderName  ⚡Bot  ✓   │
│  @platform · 跟单链接    │
│  ROI: +234.5%   PnL: $12K│
├─────────────────────────┤
│ [Overview] [Stats] [Feed]│  ← 吸顶 Tab 切换
├─────────────────────────┤
│  Tab 内容区域            │
│  (横向滑动切换 tab)      │
└─────────────────────────┘
```

关键改动:
- **吸顶 Tab Bar** — 滚动到 tab 区域后 sticky, 手指左右滑切换
- **Mini Header** — 滚动过 avatar 后显示缩略顶栏 (名字 + ROI)
- **Stats Grid** — 2×3 网格卡片 (ROI, PnL, Win%, MDD, Sharpe, Score)
- **收起/展开** — 高级指标默认收起, 点击展开

### 1.3 排行榜卡片模式
**优先级: P1 | 影响: 首页**

在现有表格视图之外, 增加卡片视图选项:
```
┌──────────────────┐
│ #1  TraderName   │
│ Binance · 90D    │
│ ┌──────┬───────┐ │
│ │ ROI  │ Score │ │
│ │+234% │ 87.3  │ │
│ └──────┴───────┘ │
│ PnL: $12.5K      │
└──────────────────┘
```

- 切换按钮: 列表/卡片 (记住用户偏好到 localStorage)
- 卡片高度固定, 支持虚拟滚动
- 横向滑动可快速查看更多指标

### 1.4 移动端搜索增强
**优先级: P1 | 影响: 核心路径**

当前 MobileSearchOverlay 已可用, 增强:
- 搜索历史 (localStorage, 最近 10 条)
- 热门搜索 (从 Redis 读取 top search terms)
- 搜索结果分类: Traders / Exchanges / Groups
- 键盘 "Enter" 直接跳转第一个结果

---

## Phase 2: 手势与交互 (2-3 周)

### 2.1 左右滑动手势
**优先级: P1**

```
位置: app/components/ui/SwipeableView.tsx
```

- Trader Detail Tabs: 左右滑切换 tab
- 首页 Sub Nav (Rankings / Following / Feed): 左右滑切换
- 使用 `framer-motion` 或轻量 `use-gesture` 库
- 滑动阈值: 50px, 速度感知

### 2.2 排行榜行操作
**优先级: P2**

长按或左滑 trader 行:
- 快捷操作: 加入 Watchlist / 对比 / 查看交易所
- 轻触 haptic feedback
- Swipe-to-action (iOS 风格)

### 2.3 底部 Sheet (Bottom Sheet)
**优先级: P1**

```
位置: app/components/ui/BottomSheet.tsx
```

替代移动端弹窗/模态框:
- 筛选器 (交易所、时间段、排序) → Bottom Sheet
- 分享面板 → Bottom Sheet
- Trader 快捷操作 → Bottom Sheet
- 拖拽手柄 + 弹性滚动
- 三个高度档位: 30% / 60% / 90%

### 2.4 图表优化
**优先级: P1 | 影响: Trader Detail**

- 权益曲线: 全屏横屏模式按钮
- 简化 TradingView 工具栏 (移动端只保留时间切换)
- Touch 缩放平滑
- 图表加载 skeleton

---

## Phase 3: 性能与离线 (2 周)

### 3.1 图片优化
**优先级: P0**

- Avatar: 使用 Next.js `<Image>` + `sizes` 属性
  - Mobile: 32px (列表), 64px (详情)
  - Desktop: 40px (列表), 96px (详情)
- Exchange icons: 生成 WebP 格式, 用 `<picture>` 降级
- 懒加载: 首屏以下图片 `loading="lazy"`
- CDN: avatar proxy 增加 `?w=64&q=80` 参数

### 3.2 虚拟滚动
**优先级: P1**

排行榜 100+ 条目时启用虚拟滚动:
```
库: @tanstack/react-virtual (已在项目依赖中)
触发: 当 traders.length > 50
行高: 52px 固定
过扫描: 5 行
```

### 3.3 Service Worker (PWA 离线)
**优先级: P2**

```
位置: public/sw.js
策略:
- API 响应: Network First, 5s 超时后用缓存
- 静态资源: Cache First
- 图片: Stale While Revalidate
- 离线页面: 自定义 /offline 页面
```

### 3.4 Bundle 优化
**优先级: P1**

- 移动端条件加载: 重型组件 (TradingView, Radar Chart) 用 `dynamic()` + intersection observer
- 拆分 responsive.css → mobile.css + desktop.css, 按 media 加载
- 减少首屏 JS: 目标 < 150KB gzipped

---

## Phase 4: 社交 & 高级功能 (2-3 周)

### 4.1 Groups 移动端优化
**优先级: P2**

- 群组列表: 卡片式, 显示成员 avatar 堆叠
- 群组详情: 类似微信群聊布局
- 创建群组: 多步骤 Bottom Sheet 表单
- 邀请: 分享链接 + 二维码

### 4.2 Feed/Posts 移动端
**优先级: P2**

- 帖子卡片: 全宽, 大图预览
- 双击点赞动画 (心形飘出)
- 评论区: Bottom Sheet 弹出
- 图片浏览器: 捏合缩放, 左右滑动

### 4.3 用户中心 (Me Tab)
**优先级: P2**

底部导航 "Me" tab 重新设计:
```
┌─────────────────────────┐
│ [Avatar]  UserName      │
│ Pro Member · 2026-12-31 │
├─────────────────────────┤
│ 📊 我的 Watchlist  (12) │
│ 📈 我的对比        (3)  │
│ 📝 我的帖子        (5)  │
│ 👥 我的群组        (2)  │
├─────────────────────────┤
│ ⚙️ 设置                 │
│ 🌐 语言 中/En           │
│ 🌙 深色/浅色            │
│ 📱 推送通知             │
├─────────────────────────┤
│ 💎 升级 Pro             │
│ ❓ 帮助与反馈           │
└─────────────────────────┘
```

### 4.4 推送通知
**优先级: P3**

- Web Push API (Service Worker)
- 通知类型: Watchlist 交易员大幅波动, 群组新消息, 新评论
- 通知偏好设置页面
- 静默推送: 每日排行榜变化摘要

---

## Phase 5: 原生壳 (Capacitor) (3-4 周)

### 5.1 Capacitor 集成
**优先级: P3**

```bash
npx cap init ArenaFi org.arenafi.app
npx cap add ios
npx cap add android
```

增强:
- 触觉反馈 (已有 `useCapacitorHaptics` hook)
- 原生分享面板
- 生物识别登录
- 本地推送通知
- App Store / Play Store 上架

### 5.2 iOS 特定优化
- 状态栏自适应 (dark/light)
- 圆角屏幕适配
- 手势返回 (edge swipe)
- Dynamic Island 适配 (iPhone 14 Pro+)

### 5.3 Android 特定优化
- Material You 主题色
- 返回手势兼容
- 分屏/折叠屏适配
- Android 快捷方式 (长按 App 图标)

---

## 技术选型

| 需求 | 方案 | 理由 |
|------|------|------|
| 手势 | `@use-gesture/react` | 轻量 (~3KB), React hooks 原生 |
| 动画 | `framer-motion` (已有) | 手势 + 动画一体, layout 动画 |
| 虚拟滚动 | `@tanstack/react-virtual` | 已在依赖中, hooks API |
| Bottom Sheet | 自建组件 | 避免引入重型 UI 库 |
| 下拉刷新 | 自建组件 | 需与 React Query 深度集成 |
| 图片 | Next.js `<Image>` | 框架自带, 自动 WebP + srcSet |
| Service Worker | `next-pwa` or workbox | Next.js 生态, 配置简单 |
| 原生壳 | Capacitor | 已有 hook, Web 代码复用 |

---

## 里程碑与度量

### 度量指标
| 指标 | 当前 | 目标 |
|------|------|------|
| Mobile Lighthouse Performance | ~65 | ≥ 85 |
| FCP (3G) | ~3.5s | < 2.0s |
| LCP (3G) | ~5.0s | < 3.0s |
| CLS | ~0.05 | < 0.01 |
| TTI (3G) | ~6.0s | < 3.5s |
| Mobile 首屏 JS | ~250KB | < 150KB |
| Touch 操作延迟 | 无优化 | < 100ms |

### 里程碑
| Phase | 交付物 | 预计状态 |
|-------|--------|----------|
| Phase 1 | 下拉刷新, Trader Detail 重组, 卡片视图, 搜索增强 | Core UX |
| Phase 2 | 滑动手势, Bottom Sheet, 图表优化 | 交互升级 |
| Phase 3 | 图片优化, 虚拟滚动, SW, Bundle 减小 | 性能达标 |
| Phase 4 | 社交优化, Me Tab, 推送通知 | 功能完整 |
| Phase 5 | Capacitor iOS/Android | 原生上架 |

---

## 实施优先级总览

```
P0 (必须做):
  ├── 下拉刷新
  ├── Trader Detail 移动端重组
  ├── 图片优化 (srcSet + lazy)
  └── Mini Header 吸顶

P1 (应该做):
  ├── 排行榜卡片视图
  ├── 左右滑动手势
  ├── Bottom Sheet 组件
  ├── 图表移动端优化
  ├── 虚拟滚动
  ├── 搜索增强
  └── Bundle 减小

P2 (最好做):
  ├── Groups 移动端优化
  ├── Feed/Posts 优化
  ├── Me Tab 重设计
  ├── Service Worker
  └── 排行榜行操作 (长按/滑动)

P3 (远期):
  ├── Capacitor 原生壳
  ├── 推送通知
  └── App Store 上架
```

---

## 文件变更预估

| Phase | 新增文件 | 修改文件 | 预估行数变更 |
|-------|---------|---------|-------------|
| Phase 1 | 3-4 | 8-10 | +800, -200 |
| Phase 2 | 3-4 | 6-8 | +600, -100 |
| Phase 3 | 2-3 | 10-12 | +400, -300 |
| Phase 4 | 2-3 | 8-10 | +500, -100 |
| Phase 5 | 10+ | 5-8 | +1500, -0 |
