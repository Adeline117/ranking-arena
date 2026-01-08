# 用户默认头像系统

## 概述

系统为每个用户自动生成一个基于用户ID的**确定性默认头像**。相同用户ID总是生成相同的头像，确保一致性。

## 设计特点

### 1. 确定性生成
- 基于用户ID生成，相同ID总是产生相同的头像
- 不依赖随机数，确保每次显示一致

### 2. 视觉设计
- **渐变背景**：基于用户ID生成独特的HSL渐变色彩
- **首字母显示**：显示用户名的首字母（支持中文、英文、数字）
- **颜色范围**：饱和度70-90%，亮度40-60%，确保颜色鲜艳但不过亮

### 3. 优先级
1. **真实头像**：如果用户上传了头像，优先显示
2. **默认头像**：如果没有真实头像，显示基于ID生成的默认头像

## 实现细节

### 核心函数

#### `getAvatarColor(userId: string)`
根据用户ID生成一个HSL颜色值。

```typescript
// 示例
getAvatarColor('user-123') // "hsl(72, 82%, 52%)"
```

#### `getAvatarGradient(userId: string)`
根据用户ID生成一个CSS渐变背景。

```typescript
// 示例
getAvatarGradient('user-123') 
// "linear-gradient(135deg, hsl(282, 72%, 42%), hsl(282, 72%, 52%))"
```

#### `getAvatarInitial(name: string)`
提取用户名的首字母。

- 支持中文：直接返回第一个中文字符
- 支持英文：返回大写首字母
- 支持邮箱：自动提取@前的部分
- 支持数字：返回数字字符

```typescript
// 示例
getAvatarInitial('Alice') // "A"
getAvatarInitial('张三') // "张"
getAvatarInitial('alice@example.com') // "A"
getAvatarInitial('92241758') // "9"
```

#### `generateDefaultAvatarUrl(userId, name, provider)`
生成第三方头像服务URL（可选）。

- **DiceBear Avatars**：基于seed生成确定性SVG头像
- **UI Avatars**：简单但功能有限

### Avatar 组件

位置：`app/components/UI/Avatar.tsx`

#### 使用方式

```tsx
import Avatar from '@/app/components/UI/Avatar'

// 基本用法
<Avatar 
  userId="user-123" 
  name="Alice" 
  avatarUrl={user.avatar_url}
  size={40}
/>

// 仅显示默认头像（无真实头像）
<Avatar 
  userId="user-123" 
  name="Alice"
  size={40}
/>
```

#### Props

- `userId` (string, 必需): 用户唯一ID
- `name` (string | null, 可选): 用户显示名称
- `avatarUrl` (string | null, 可选): 真实头像URL
- `size` (number, 可选): 头像尺寸，默认40
- `className` (string, 可选): CSS类名
- `style` (CSSProperties, 可选): 内联样式

## 已集成的组件

### 1. 排行榜 (`RankingTable.tsx`)
- 显示交易员头像
- 如果没有真实头像，显示基于ID的默认头像

### 2. 相似交易员 (`SimilarTraders.tsx`)
- 显示推荐交易员的头像
- 支持钱包地址缩写显示

### 3. 设置页面 (`settings/page.tsx`)
- 显示用户当前头像
- 支持上传新头像

## 颜色生成算法

### HSL颜色空间
- **色相 (Hue)**: 0-360度，基于用户ID哈希值
- **饱和度 (Saturation)**: 70-90%，确保颜色鲜艳
- **亮度 (Lightness)**: 40-60%，确保不过亮或过暗

### 哈希算法
```typescript
let hash = 0
for (let i = 0; i < userId.length; i++) {
  hash = userId.charCodeAt(i) + ((hash << 5) - hash)
}
const hue = Math.abs(hash) % 360
```

## 示例效果

### 不同用户ID的头像

| 用户ID | 名称 | 颜色 | 首字母 | 渐变效果 |
|--------|------|------|--------|----------|
| `user-123` | Alice | hsl(72, 82%, 52%) | A | 黄绿色渐变 |
| `user-456` | Bob | hsl(333, 83%, 53%) | B | 粉红色渐变 |
| `user-789` | 张三 | hsl(234, 84%, 54%) | 张 | 蓝紫色渐变 |
| `92241758` | 92*****8 | hsl(92, 82%, 52%) | 9 | 黄绿色渐变 |

## 优势

1. **无需存储**：不需要在数据库中存储默认头像URL
2. **性能优化**：纯CSS渐变，无需加载外部图片
3. **一致性**：相同用户ID总是显示相同头像
4. **美观性**：渐变背景+首字母，视觉效果良好
5. **可扩展**：支持集成第三方头像服务（DiceBear等）

## 未来改进

- [ ] 支持更多头像风格（圆形、方形、圆角方形）
- [ ] 支持自定义头像边框
- [ ] 支持头像加载动画
- [ ] 支持头像缓存优化



