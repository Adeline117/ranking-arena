# Ranking Arena - User Operations Guide
# 用户操作指南

> Complete documentation of all user-facing operations in Ranking Arena.
>
> Ranking Arena 所有用户操作的完整文档。

---

## Table of Contents / 目录

1. [Authentication & Account / 认证与账户](#1-authentication--account--认证与账户)
2. [User Profile / 用户资料](#2-user-profile--用户资料)
3. [Trader Operations / 交易员操作](#3-trader-operations--交易员操作)
4. [Posts & Content / 帖子与内容](#4-posts--content--帖子与内容)
5. [Comments / 评论](#5-comments--评论)
6. [Social Features / 社交功能](#6-social-features--社交功能)
7. [Private Messaging / 私信](#7-private-messaging--私信)
8. [Groups / 小组](#8-groups--小组)
9. [Notifications / 通知](#9-notifications--通知)
10. [Bookmarks & Collections / 收藏夹](#10-bookmarks--collections--收藏夹)
11. [Search / 搜索](#11-search--搜索)
12. [Subscription & Payment / 订阅与支付](#12-subscription--payment--订阅与支付)
13. [Exchange Connections / 交易所连接](#13-exchange-connections--交易所连接)
14. [Settings / 设置](#14-settings--设置)

---

## 1. Authentication & Account / 认证与账户

### 1.1 Registration / 注册
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Email Sign Up | 邮箱注册 | Register with email and password | 使用邮箱和密码注册 |

### 1.2 Login / 登录
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Email Login | 邮箱登录 | Login with email and password | 使用邮箱和密码登录 |
| OAuth Login | 第三方登录 | Login with Google/GitHub | 使用 Google/GitHub 登录 |

### 1.3 Logout / 退出登录
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Logout | 退出登录 | End current session | 结束当前会话 |

### 1.4 Password Management / 密码管理
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Reset Password | 重置密码 | Request password reset via email | 通过邮箱请求重置密码 |
| Change Password | 修改密码 | Change password in settings | 在设置中修改密码 |

### 1.5 Account Deletion / 账户删除
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Request Deletion | 申请删除 | Initiate 30-day deletion countdown | 发起 30 天删除倒计时 |
| Cancel Deletion | 取消删除 | Cancel pending account deletion | 取消待删除的账户删除 |
| Confirm Deletion | 确认删除 | Requires password confirmation | 需要密码确认 |

---

## 2. User Profile / 用户资料

### 2.1 View Profile / 查看资料
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Own Profile | 查看自己主页 | Access via `/u/[handle]` | 访问 `/u/[handle]` |
| View Other Profile | 查看他人主页 | View another user's profile | 查看其他用户的资料 |

### 2.2 Edit Profile / 编辑资料
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Edit Handle | 修改用户名 | Change display name | 修改显示名称 |
| Edit Bio | 修改简介 | Update personal bio | 更新个人简介 |
| Upload Avatar | 上传头像 | Upload and crop profile picture | 上传并裁剪头像 |
| Upload Cover | 上传封面 | Upload cover image | 上传封面图片 |
| Edit Social Links | 编辑社交链接 | Add Twitter/Telegram/Discord | 添加 Twitter/Telegram/Discord |

### 2.3 Privacy Settings / 隐私设置
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Show/Hide Followers | 显示/隐藏粉丝 | Toggle followers visibility | 切换粉丝可见性 |
| Show/Hide Following | 显示/隐藏关注 | Toggle following visibility | 切换关注可见性 |
| DM Permission | 私信权限 | Set who can message you (all/mutual/none) | 设置谁可以给你发私信 |

---

## 3. Trader Operations / 交易员操作

### 3.1 Browse Traders / 浏览交易员
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Leaderboard | 查看排行榜 | Browse trader rankings | 浏览交易员排名 |
| Filter by Exchange | 按交易所筛选 | Filter by Binance/Bybit/etc | 按 Binance/Bybit 等筛选 |
| Sort by Metrics | 按指标排序 | Sort by ROI/Win Rate/Drawdown | 按 ROI/胜率/回撤排序 |
| View Trader Detail | 查看交易员详情 | Access `/trader/[handle]` | 访问 `/trader/[handle]` |

### 3.2 Follow Traders / 关注交易员
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Follow Trader | 关注交易员 | Add trader to following list | 添加交易员到关注列表 |
| Unfollow Trader | 取消关注 | Remove trader from following | 从关注中移除交易员 |
| View Following List | 查看关注列表 | See all followed traders | 查看所有已关注的交易员 |

### 3.3 Favorite Traders / 收藏交易员
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Add to Favorites | 添加收藏 | Star a trader | 收藏交易员 |
| Remove from Favorites | 取消收藏 | Unstar a trader | 取消收藏交易员 |

### 3.4 Claim Trader Account / 认领交易员账户
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Apply to Claim | 申请认领 | Submit claim for trader account | 提交交易员账户认领申请 |
| Verify Ownership | 验证所有权 | Prove you own the account | 证明你拥有该账户 |
| View Claim Status | 查看认领状态 | Check claim approval status | 查看认领审批状态 |

### 3.5 Copy Trading / 跟单交易
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Copy Trade Link | 查看跟单链接 | Access exchange copy trade page | 访问交易所跟单页面 |
| Acknowledge Risk | 确认风险 | Accept risk disclaimer | 接受风险免责声明 |
| Jump to Exchange | 跳转交易所 | Redirect to exchange platform | 重定向到交易所平台 |

### 3.6 Similar Traders / 相似交易员
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Similar Traders | 查看相似交易员 | See traders with similar style | 查看风格相似的交易员 |

---

## 4. Posts & Content / 帖子与内容

### 4.1 Create Post / 创建帖子
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Write Post | 发帖 | Create new post with title and content | 创建带标题和内容的新帖子 |
| Add Images | 添加图片 | Upload images to post | 上传图片到帖子 |
| Add Video | 添加视频 | Upload video to post | 上传视频到帖子 |
| Create Poll | 创建投票 | Add poll to post | 在帖子中添加投票 |
| Post to Group | 发到小组 | Post in specific group | 发布到特定小组 |

### 4.2 Edit Post / 编辑帖子
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Edit Title | 编辑标题 | Modify post title | 修改帖子标题 |
| Edit Content | 编辑内容 | Modify post content | 修改帖子内容 |

### 4.3 Delete Post / 删除帖子
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Delete Own Post | 删除自己的帖子 | Permanently remove post | 永久删除帖子 |

### 4.4 Post Interactions / 帖子互动
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Like Post | 点赞 | Upvote a post | 给帖子点赞 |
| Dislike Post | 点踩 | Downvote a post | 给帖子点踩 |
| Bookmark Post | 收藏帖子 | Save post to bookmarks | 保存帖子到收藏夹 |
| Share Post | 分享帖子 | Share post link | 分享帖子链接 |
| Repost | 转发 | Repost to your profile | 转发到你的主页 |
| Pin Post | 置顶 | Pin post to profile/group | 置顶帖子到主页/小组 |

### 4.5 Poll Voting / 投票
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Vote on Poll | 参与投票 | Submit vote on poll | 在投票中提交选票 |
| View Results | 查看结果 | See poll results after voting | 投票后查看结果 |

---

## 5. Comments / 评论

### 5.1 Comment Operations / 评论操作
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Add Comment | 发表评论 | Comment on a post | 在帖子下评论 |
| Reply to Comment | 回复评论 | Reply to existing comment | 回复已有评论 |
| Like Comment | 点赞评论 | Upvote a comment | 给评论点赞 |
| Delete Comment | 删除评论 | Remove own comment | 删除自己的评论 |

---

## 6. Social Features / 社交功能

### 6.1 User Following / 用户关注
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Follow User | 关注用户 | Follow another user | 关注其他用户 |
| Unfollow User | 取消关注用户 | Unfollow a user | 取消关注用户 |
| View Followers | 查看粉丝 | See who follows you | 查看谁关注了你 |
| View Following | 查看关注 | See who you follow | 查看你关注了谁 |

### 6.2 Block Users / 屏蔽用户
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Block User | 屏蔽用户 | Block a user | 屏蔽某个用户 |
| Unblock User | 取消屏蔽 | Unblock a user | 取消屏蔽用户 |
| View Block List | 查看屏蔽列表 | See blocked users | 查看被屏蔽的用户 |

---

## 7. Private Messaging / 私信

### 7.1 Conversations / 会话
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Conversations | 查看会话列表 | See all conversations | 查看所有会话 |
| Start Conversation | 发起会话 | Message a new user | 给新用户发消息 |
| Delete Conversation | 删除会话 | Remove conversation | 删除会话 |

### 7.2 Messages / 消息
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Send Message | 发送消息 | Send text message | 发送文字消息 |
| Send Image | 发送图片 | Send image in chat | 在聊天中发送图片 |
| Read Messages | 阅读消息 | Mark messages as read | 标记消息为已读 |

### 7.3 Conversation Settings / 会话设置
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Mute Conversation | 静音会话 | Mute notifications | 静音通知 |
| Pin Conversation | 置顶会话 | Pin to top of list | 置顶到列表顶部 |
| Set Remark | 设置备注 | Add nickname for user | 为用户添加备注名 |

---

## 8. Groups / 小组

### 8.1 Browse Groups / 浏览小组
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View All Groups | 查看所有小组 | Browse group directory | 浏览小组目录 |
| Search Groups | 搜索小组 | Search by name | 按名称搜索 |
| View Group Detail | 查看小组详情 | Access `/groups/[id]` | 访问 `/groups/[id]` |

### 8.2 Join Groups / 加入小组
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Join Free Group | 加入免费小组 | Join public group | 加入公开小组 |
| Subscribe to Premium Group | 订阅付费小组 | Pay to join premium group | 付费加入高级小组 |
| Leave Group | 退出小组 | Leave a group | 退出小组 |

### 8.3 Create Groups / 创建小组
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Apply to Create | 申请创建 | Submit group creation application | 提交小组创建申请 |
| Set Group Info | 设置小组信息 | Name, description, avatar | 名称、描述、头像 |
| Set Group Rules | 设置小组规则 | Define group rules | 定义小组规则 |

### 8.4 Group Management (Admins) / 小组管理（管理员）
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Edit Group Info | 编辑小组信息 | Modify group details | 修改小组详情 |
| Manage Members | 管理成员 | View/manage member list | 查看/管理成员列表 |
| Ban Member | 封禁成员 | Ban user from group | 从小组封禁用户 |
| Kick Member | 踢出成员 | Remove user from group | 从小组移除用户 |
| Mute Member | 禁言成员 | Prevent user from posting | 禁止用户发帖 |
| Set Member Role | 设置成员角色 | Promote to admin/moderator | 提升为管理员/版主 |
| Delete Post | 删除帖子 | Remove post from group | 从小组删除帖子 |
| Pin Post | 置顶帖子 | Pin post in group | 在小组中置顶帖子 |

---

## 9. Notifications / 通知

### 9.1 Notification Management / 通知管理
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Notifications | 查看通知 | See all notifications | 查看所有通知 |
| Mark as Read | 标记已读 | Mark notification as read | 标记通知为已读 |
| Mark All as Read | 全部标记已读 | Mark all as read | 全部标记为已读 |
| Delete Notification | 删除通知 | Remove notification | 删除通知 |

### 9.2 Notification Types / 通知类型
| Type | 类型 | Description | 描述 |
|------|------|-------------|------|
| New Follower | 新粉丝 | Someone followed you | 有人关注了你 |
| New Comment | 新评论 | Comment on your post | 在你的帖子下评论 |
| New Like | 新点赞 | Like on your post/comment | 在你的帖子/评论点赞 |
| New Message | 新私信 | New private message | 新的私信 |
| Group Activity | 小组动态 | Activity in your groups | 你的小组中的动态 |
| Trader Alert | 交易员提醒 | Alert for followed traders | 关注的交易员提醒 |

---

## 10. Bookmarks & Collections / 收藏夹

### 10.1 Bookmark Folders / 收藏夹文件夹
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Create Folder | 创建文件夹 | Create new bookmark folder | 创建新收藏夹文件夹 |
| Edit Folder | 编辑文件夹 | Rename or update folder | 重命名或更新文件夹 |
| Delete Folder | 删除文件夹 | Remove folder and contents | 删除文件夹及其内容 |
| Set Public/Private | 设置公开/私密 | Toggle folder visibility | 切换文件夹可见性 |

### 10.2 Bookmark Operations / 收藏操作
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Add Bookmark | 添加收藏 | Save item to folder | 保存项目到文件夹 |
| Remove Bookmark | 移除收藏 | Remove from bookmarks | 从收藏中移除 |
| Move Bookmark | 移动收藏 | Move to different folder | 移动到不同文件夹 |

### 10.3 Public Collections / 公开收藏夹
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Subscribe to Collection | 订阅收藏夹 | Follow public collection | 关注公开收藏夹 |
| View Public Collections | 查看公开收藏夹 | Browse others' collections | 浏览他人的收藏夹 |

---

## 11. Search / 搜索

### 11.1 Search Operations / 搜索操作
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Search Traders | 搜索交易员 | Find traders by name | 按名称搜索交易员 |
| Search Posts | 搜索帖子 | Find posts by content | 按内容搜索帖子 |
| Search Groups | 搜索小组 | Find groups by name | 按名称搜索小组 |
| Search Users | 搜索用户 | Find users by handle | 按用户名搜索用户 |

### 11.2 Advanced Filters / 高级筛选
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Filter by Exchange | 按交易所筛选 | Filter by exchange source | 按交易所来源筛选 |
| Filter by Time Range | 按时间筛选 | Filter by date range | 按日期范围筛选 |
| Filter by Metrics | 按指标筛选 | Filter by ROI/drawdown/etc | 按 ROI/回撤等筛选 |
| Sort Results | 排序结果 | Sort search results | 排序搜索结果 |

### 11.3 Search History / 搜索历史
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Recent Searches | 查看最近搜索 | See search history | 查看搜索历史 |
| Clear Search History | 清除搜索历史 | Remove search history | 删除搜索历史 |

---

## 12. Subscription & Payment / 订阅与支付

### 12.1 Pro Subscription / Pro 订阅
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Pricing | 查看价格 | See subscription options | 查看订阅选项 |
| Subscribe Monthly | 月度订阅 | Subscribe for 1 month | 订阅 1 个月 |
| Subscribe Yearly | 年度订阅 | Subscribe for 1 year | 订阅 1 年 |
| Cancel Subscription | 取消订阅 | Cancel auto-renewal | 取消自动续费 |

### 12.2 Payment Management / 支付管理
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Update Payment Method | 更新支付方式 | Change credit card | 更换信用卡 |
| View Billing History | 查看账单历史 | See past payments | 查看历史付款 |
| Download Invoice | 下载发票 | Get payment invoice | 获取付款发票 |

### 12.3 Group Subscriptions / 小组订阅
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Subscribe to Group | 订阅小组 | Pay for premium group | 付费加入高级小组 |
| Cancel Group Sub | 取消小组订阅 | Cancel group subscription | 取消小组订阅 |
| Try Group Trial | 试用小组 | Start free trial | 开始免费试用 |

---

## 13. Exchange Connections / 交易所连接

### 13.1 Connect Exchange / 连接交易所
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Connect via OAuth | OAuth 连接 | Authorize via exchange OAuth | 通过交易所 OAuth 授权 |
| Connect via API Key | API Key 连接 | Enter API key manually | 手动输入 API 密钥 |
| Verify Connection | 验证连接 | Test exchange connection | 测试交易所连接 |

### 13.2 Supported Exchanges / 支持的交易所
| Exchange | 交易所 | Connection Methods | 连接方式 |
|----------|--------|-------------------|----------|
| Binance | 币安 | OAuth, API Key | OAuth, API 密钥 |
| Bybit | Bybit | OAuth, API Key | OAuth, API 密钥 |
| Bitget | Bitget | API Key + Passphrase | API 密钥 + 口令 |
| OKX | 欧易 | OAuth, API Key | OAuth, API 密钥 |
| MEXC | 抹茶 | API Key | API 密钥 |
| KuCoin | 库币 | API Key | API 密钥 |

### 13.3 Manage Connections / 管理连接
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| View Connections | 查看连接 | See connected exchanges | 查看已连接的交易所 |
| Sync Data | 同步数据 | Manually sync exchange data | 手动同步交易所数据 |
| Disconnect Exchange | 断开连接 | Remove exchange connection | 移除交易所连接 |
| Refresh Token | 刷新令牌 | Renew OAuth token | 更新 OAuth 令牌 |

---

## 14. Settings / 设置

### 14.1 Account Settings / 账户设置
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Change Email | 修改邮箱 | Update email address | 更新邮箱地址 |
| Change Password | 修改密码 | Update password | 更新密码 |
| Enable 2FA | 启用两步验证 | Set up TOTP authentication | 设置 TOTP 认证 |
| Disable 2FA | 禁用两步验证 | Turn off 2FA | 关闭两步验证 |
| Manage Sessions | 管理登录会话 | View/revoke active sessions | 查看/撤销活跃会话 |

### 14.2 Preferences / 偏好设置
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Change Language | 切换语言 | Switch between zh/en | 在中/英文之间切换 |
| Change Theme | 切换主题 | Switch light/dark mode | 切换浅色/深色模式 |
| Notification Preferences | 通知偏好 | Configure notification settings | 配置通知设置 |

### 14.3 Data & Privacy / 数据与隐私
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Export Data | 导出数据 | Download all your data | 下载你的所有数据 |
| Delete Account | 删除账户 | Permanently delete account | 永久删除账户 |

### 14.4 Pro Settings / Pro 设置
| Operation | 操作 | Description | 描述 |
|-----------|------|-------------|------|
| Show/Hide Pro Badge | 显示/隐藏 Pro 徽章 | Toggle Pro badge visibility | 切换 Pro 徽章可见性 |

---

## Quick Reference / 快速参考

### Keyboard Shortcuts / 键盘快捷键
| Shortcut | 快捷键 | Action | 操作 |
|----------|--------|--------|------|
| `/` | `/` | Focus search | 聚焦搜索 |
| `Esc` | `Esc` | Close modal | 关闭弹窗 |
| `↑` / `↓` | `↑` / `↓` | Navigate search results | 导航搜索结果 |
| `Enter` | `Enter` | Select search result | 选择搜索结果 |

### Mobile Gestures / 移动端手势
| Gesture | 手势 | Action | 操作 |
|---------|------|--------|------|
| Pull down | 下拉 | Refresh content | 刷新内容 |
| Swipe left | 左滑 | Delete/Archive | 删除/归档 |
| Long press | 长按 | Context menu | 上下文菜单 |

---

## API Rate Limits / API 速率限制

| Operation Type | 操作类型 | Limit | 限制 |
|----------------|----------|-------|------|
| Public Read | 公开读取 | 100/min | 100次/分钟 |
| Authenticated Read | 认证读取 | 500/min | 500次/分钟 |
| Write Operations | 写入操作 | 50/min | 50次/分钟 |
| Sensitive Operations | 敏感操作 | 10/min | 10次/分钟 |

---

*Last updated: 2026-01-28*
*最后更新：2026-01-28*
