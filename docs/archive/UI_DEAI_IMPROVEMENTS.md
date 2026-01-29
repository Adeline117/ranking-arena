# UI去"AI味"改进清单

## 1. "AI味"典型症状定位

### 高优先级（影响用户感知）

| 位置 | 当前问题 | 修改建议 | 状态 |
|------|----------|----------|------|
| `StateComponents.tsx:ERROR_DESCRIPTIONS` | "发生了未知错误，请稍后重试" | "加载失败，刷新试试" | ✅ 已修复 |
| `StateComponents.tsx:ERROR_DESCRIPTIONS` | "服务器暂时不可用，请稍后重试" | "服务繁忙，稍后再试" | ✅ 已修复 |
| `StateComponents.tsx:ERROR_DESCRIPTIONS` | "您没有权限访问此内容" | "无权限访问" | ✅ 已修复 |
| `PostFeed.tsx:showToast` | "转发成功！已发布到你的主页" | "已转发" | ✅ 已修复 |
| `PostFeed.tsx:showToast` | "已收藏到默认收藏夹" | "已收藏" | ✅ 已修复 |
| `FollowButton.tsx` | "处理中..." | "关注中" / "取消中" | ✅ 已修复 |

### 中优先级

| 位置 | 当前问题 | 修改建议 | 状态 |
|------|----------|----------|------|
| `Dialog.tsx` | 默认 confirmText='确定', cancelText='取消' | 使用 i18n: `t('confirm')` | ✅ 已修复 |
| `Toast.tsx` | fallback "操作失败" | 根据type显示 "出错了"/"完成" | ✅ 已修复 |
| `PremiumGate.tsx` | "此功能仅限 Pro 会员使用" | "Pro 专属" | ✅ 已修复 |
| `UpgradePrompt.tsx` | "解锁更多高级功能" | 使用 t('proOnly') | ✅ 已修复 |

---

## 2. 文案改写规则

### 中文规则
```
✗ 避免                          ✓ 使用
───────────────────────────────────────────
"操作成功！"                    → "已完成"
"正在处理中..."                 → "处理中"
"发生了未知错误，请稍后重试"     → "出错了，刷新试试"
"您没有权限访问此内容"          → "无权限"
"此功能需要 Pro 会员"           → "Pro 专属"
"是否确认删除？此操作不可撤销"   → "确定删除？"
"请先登录后再进行此操作"        → "请先登录"
```

### 英文规则
```
✗ Avoid                         ✓ Use
───────────────────────────────────────────
"Operation completed!"          → "Done"
"Processing your request..."    → "Loading"
"An unknown error occurred"     → "Something went wrong"
"You don't have permission"     → "No access"
"This feature requires Pro"     → "Pro only"
"Are you sure? Cannot undo"     → "Delete?"
```

---

## 3. 组件一致性规范

### 按钮状态
```typescript
// Button.tsx 已实现，确保所有按钮遵循
- default: 正常可点击
- hover: 颜色变化 + 轻微放大
- active: 颜色加深
- loading: spinner + 禁用
- disabled: 灰色 + cursor-not-allowed
```

### 空状态
```typescript
// StateComponents.tsx 统一模板
<EmptyState
  icon={<IconName />}        // 相关图标，非通用"空"图标
  title="暂无关注"           // 具体到内容类型
  description="关注感兴趣的交易员"  // 引导下一步行动
  action={<Button>发现交易员</Button>}  // 可选行动按钮
/>
```

### 错误状态
```typescript
// 根据错误类型显示不同内容
- network: "网络不稳定" + 重试按钮
- 404: "找不到内容" + 返回按钮
- 403: "无权限" + 升级/登录按钮
- 500: "服务异常" + 刷新按钮
```

### Toast
```typescript
// 统一时长和样式
- success: 2秒，绿色
- error: 4秒，红色
- warning: 3秒，黄色
- info: 2秒，蓝色
```

---

## 4. 交互细节修复清单

| 位置 | 问题 | 修复 | 状态 |
|------|------|------|------|
| 所有异步按钮 | 缺少 loading 反馈 | 添加 `isLoading` 状态 | 待检查 |
| 表单提交 | Enter 键行为不一致 | 统一：单行 Enter 提交，多行 Cmd+Enter | 待修复 |
| Modal 关闭 | ESC 键不工作 | 添加 `onKeyDown` 监听 | ✅ Dialog已支持 |
| 下拉菜单 | 点击外部不关闭 | 添加 `clickOutside` 处理 | 待检查 |
| 输入框 | 无最大长度提示 | 显示字符计数 "0/280" | 待添加 |

---

## 5. Top 20 立即可改清单

| # | 位置 | 改动 | 影响 | 状态 |
|---|------|------|------|------|
| 1 | `StateComponents.tsx:305` | 错误描述改为口语化 | 高 | ✅ |
| 2 | `PostFeed.tsx` 所有 showToast | 移除感叹号，精简文案 | 高 | ✅ |
| 3 | `FollowButton.tsx:164` | "处理中"→具体动作 | 高 | ✅ |
| 4 | `PremiumGate.tsx` | 文案精简 | 中 | ✅ |
| 5 | `Dialog.tsx` | 使用 i18n | 中 | ✅ |
| 6 | `Toast.tsx:240` | 移除泛化 fallback | 中 | ✅ |
| 7 | `StateComponents.tsx:296` | 空状态添加行动引导 | 中 | 待处理 |
| 8 | `UpgradePrompt.tsx` | 文案去营销味 | 中 | ✅ |
| 9 | 所有 "您" | 改为 "你" 或无主语 | 中 | 部分完成 |
| 10 | 所有 "请稍后重试" | 改为 "刷新试试" | 中 | ✅ |
| 11 | `MessageButton.tsx` | 添加 loading 状态 | 中 | 待检查 |
| 12 | `TopNav.tsx:442` | aria-label 国际化 | 低 | 待处理 |
| 13 | `UserFollowButton.tsx` | "互相关注"文案检查 | 低 | 待检查 |
| 14 | 表单验证提示 | 统一格式 | 低 | 待处理 |
| 15 | 确认弹窗 | 去掉冗余说明 | 低 | 待处理 |
| 16 | 时间格式 | 统一为"刚刚/X分钟前" | 低 | 待检查 |
| 17 | 数字格式 | 统一千分位处理 | 低 | 待检查 |
| 18 | 图片加载失败 | 显示占位图而非空白 | 低 | 待检查 |
| 19 | 骨架屏 | 统一动画频率 | 低 | 待检查 |
| 20 | 工具提示 | 延迟统一为 300ms | 低 | 待检查 |

---

## 6. 新增i18n键（本次修复）

```typescript
// lib/i18n.ts 新增键
confirm: '确定' / 'Confirm'
unfollow: '取消关注' / 'Unfollow'
mutualFollow: '互相关注' / 'Mutual'
followBack: '回关' / 'Follow Back'
messages: '私信' / 'Messages'
followingAction: '关注中' / 'Following'
unfollowingAction: '取消中' / 'Unfollowing'
networkError: '网络错误' / 'Network error'
operationFailed: '操作失败' / 'Failed'
timeout: '超时了' / 'Timed out'
saved: '已保存' / 'Saved'
deleted: '已删除' / 'Deleted'
replied: '已回复' / 'Replied'
voted: '已投票' / 'Voted'
bookmarked: '已收藏' / 'Bookmarked'
unbookmarked: '已取消收藏' / 'Unbookmarked'
repostedSuccess: '已转发' / 'Reposted'
loginExpired: '登录已过期' / 'Session expired'
tooFast: '操作太快，稍等一下' / 'Too fast, wait a moment'
proOnly: 'Pro 专属' / 'Pro only'
loadFailed2: '加载失败，刷新试试' / 'Failed to load, try refreshing'
serverBusy: '服务繁忙，稍后再试' / 'Server busy, try later'
noAccess: '无权限访问' / 'No access'
contentNotFound: '内容不存在' / 'Content not found'
```
