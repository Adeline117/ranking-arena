# Components Directory Structure

## 📁 Folder Organization

```
components/
├── Base/              # 基础组件（设计系统核心）
│   ├── Box.tsx        # 容器组件
│   ├── Text.tsx       # 文字组件
│   ├── Button.tsx     # 按钮组件
│   └── index.ts       # 统一导出
│
├── Icons/             # 图标系统
│   ├── IconSystem.tsx # 所有SVG图标
│   └── index.ts       # 统一导出
│
├── Layout/            # 布局组件
│   └── TopNav.tsx     # 顶部导航栏
│
├── Features/          # 功能组件（核心业务逻辑）
│   ├── RankingTable.tsx          # 排行榜（完整版）
│   ├── RankingTableCompact.tsx   # 排行榜（紧凑版，用于侧边栏）
│   ├── MarketPanel.tsx           # 市场面板
│   ├── PostFeed.tsx              # 帖子流
│   ├── TraderDrawer.tsx          # 交易者抽屉
│   ├── CompareTraders.tsx        # 对比交易者
│   └── SearchDropdown.tsx        # 搜索下拉菜单
│
├── UI/                # UI组件（通用界面组件）
│   ├── Card.tsx            # 卡片
│   ├── Skeleton.tsx        # 骨架屏
│   ├── EmptyState.tsx      # 空状态
│   ├── ErrorMessage.tsx    # 错误信息
│   ├── FollowButton.tsx    # 关注按钮
│   └── FavoriteButton.tsx  # 收藏按钮
│
├── Utils/             # 工具组件（辅助功能）
│   ├── LanguageProvider.tsx  # 语言提供者
│   ├── LanguageSwitcher.tsx   # 语言切换
│   ├── ThemeToggle.tsx       # 主题切换
│   ├── KeyboardShortcuts.tsx # 键盘快捷键
│   └── ExportButton.tsx      # 导出按钮
│
└── trader/            # 交易者相关组件
    ├── TraderHeader.tsx           # 交易者头部
    ├── TraderTabs.tsx             # 交易者标签页
    ├── TraderAboutCard.tsx        # 交易者信息卡片
    ├── OverviewPerformanceCard.tsx # 概览性能卡片
    ├── PortfolioTable.tsx          # 投资组合表格
    ├── TraderFeed.tsx              # 交易者动态（支持All/Top排序）
    ├── PinnedPost.tsx              # 置顶帖子组件
    ├── ClaimTraderButton.tsx       # 交易员认领按钮
    ├── SimilarTraders.tsx          # 相似交易者
    ├── TradingViewShell.tsx        # 图表容器
    ├── UserHomeLayout.tsx          # 用户主页布局
    └── stats/                      # 统计相关组件
        ├── StatsPage.tsx           # 统计页面（完整版，包含Performance、Risk、Compare、Trading、Breakdown等）
        ├── TrustStats.tsx          # 信任指标
        ├── TradingStats.tsx        # 交易统计
        ├── ExpectedDividends.tsx   # 预期股息
        ├── FrequentlyTraded.tsx    # 频繁交易
        ├── AdditionalStats.tsx     # 附加统计
        └── PerformanceChart.tsx    # 性能图表
```

## 🎨 Design System

所有组件应使用统一的设计令牌：
- `lib/design-tokens.ts` - 设计令牌（颜色、间距、字体等）
- `app/components/Base/` - 基础组件（Box, Text, Button）

## 📦 Import Examples

```tsx
// 基础组件
import { Box, Text, Button } from '@/app/components/Base'

// 图标
import { SearchIcon, UserIcon, ChartIcon } from '@/app/components/Icons'

// 布局
import TopNav from '@/app/components/Layout/TopNav'

// 功能组件
import RankingTable from '@/app/components/Features/RankingTable'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import MarketPanel from '@/app/components/Features/MarketPanel'

// UI组件
import Card from '@/app/components/UI/Card'
import Skeleton from '@/app/components/UI/Skeleton'

// 工具组件
import ThemeToggle from '@/app/components/Utils/ThemeToggle'
import LanguageSwitcher from '@/app/components/Utils/LanguageSwitcher'

// 交易者组件
import TraderHeader from '@/app/components/trader/TraderHeader'
import OverviewPerformanceCard from '@/app/components/trader/OverviewPerformanceCard'
```

## 🔄 File Organization Rules

1. **Base/** - 设计系统基础组件，所有其他组件的基础
2. **Icons/** - 所有 SVG 图标集中管理
3. **Layout/** - 页面布局相关组件（如导航栏）
4. **Features/** - 核心业务功能组件
5. **UI/** - 通用 UI 组件，可在多处复用
6. **Utils/** - 工具类组件，提供辅助功能
7. **trader/** - 交易者相关专用组件

## ✅ Cleanup Completed

已删除根目录下的所有重复文件，统一使用子目录版本：
- ✅ MarketPanel → Features/MarketPanel
- ✅ RankingTable → Features/RankingTable
- ✅ CompareTraders → Features/CompareTraders
- ✅ SearchDropdown → Features/SearchDropdown
- ✅ TopNav → Layout/TopNav
- ✅ Card → UI/Card
- ✅ EmptyState → UI/EmptyState
- ✅ ErrorMessage → UI/ErrorMessage
- ✅ Skeleton → UI/Skeleton
- ✅ FavoriteButton → UI/FavoriteButton
- ✅ FollowButton → UI/FollowButton
- ✅ KeyboardShortcuts → Utils/KeyboardShortcuts
- ✅ LanguageProvider → Utils/LanguageProvider
- ✅ LanguageSwitcher → Utils/LanguageSwitcher
- ✅ ThemeToggle → Utils/ThemeToggle
- ✅ ExportButton → Utils/ExportButton
