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
├── Features/          # 功能组件
│   ├── RankingTable.tsx    # 排行榜
│   ├── MarketPanel.tsx     # 市场面板
│   ├── PostFeed.tsx        # 帖子流
│   ├── TraderDrawer.tsx    # 交易者抽屉
│   ├── CompareTraders.tsx  # 对比交易者
│   └── SearchDropdown.tsx # 搜索下拉
│
├── UI/                # UI组件
│   ├── Card.tsx            # 卡片
│   ├── Skeleton.tsx        # 骨架屏
│   ├── EmptyState.tsx      # 空状态
│   ├── ErrorMessage.tsx    # 错误信息
│   ├── FollowButton.tsx    # 关注按钮
│   └── FavoriteButton.tsx  # 收藏按钮
│
└── Utils/             # 工具组件
    ├── LanguageProvider.tsx  # 语言提供者
    ├── LanguageSwitcher.tsx   # 语言切换
    ├── ThemeToggle.tsx       # 主题切换
    ├── KeyboardShortcuts.tsx # 键盘快捷键
    └── ExportButton.tsx      # 导出按钮
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
import { SearchIcon, UserIcon } from '@/app/components/Icons'

// 布局
import TopNav from '@/app/components/Layout/TopNav'

// 功能组件
import RankingTable from '@/app/components/Features/RankingTable'

// UI组件
import Card from '@/app/components/UI/Card'
```

## 🔄 Migration Guide

旧路径 → 新路径：
- `./components/TopNav` → `./components/Layout/TopNav`
- `./components/Card` → `./components/UI/Card`
- `./components/RankingTable` → `./components/Features/RankingTable`
- `./components/AnimatedIcons` → `./components/Icons` (已删除)
- `./components/UserIcon` → `./components/Icons` (已删除)
- `./components/RankingBadge` → `./components/Icons` (已删除)

