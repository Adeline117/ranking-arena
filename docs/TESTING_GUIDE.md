# 功能测试指南

本文档提供了所有新实现功能的测试步骤。

## 前置准备

### 1. 数据库迁移

在 Supabase Dashboard 的 SQL Editor 中按顺序运行以下脚本：

```sql
-- 1. 更新小组表
-- 运行 scripts/update_groups_table.sql

-- 2. 更新帖子表
-- 运行 scripts/update_posts_table.sql

-- 3. 创建投票表
-- 运行 scripts/create_polls_table.sql

-- 4. 创建 OAuth states 表
-- 运行 scripts/create_oauth_states_table.sql
```

### 2. Supabase Storage 设置

1. 在 Supabase Dashboard 中进入 Storage
2. 创建新的 bucket：`posts`
3. 设置权限：
   - Public: 允许读取
   - Authenticated: 允许上传

### 3. 环境变量配置

在 `.env.local` 中添加（如果需要测试 OAuth）：

```env
BINANCE_OAUTH_CLIENT_ID=your_binance_client_id
BINANCE_OAUTH_CLIENT_SECRET=your_binance_client_secret
BYBIT_OAUTH_CLIENT_ID=your_bybit_client_id
BYBIT_OAUTH_CLIENT_SECRET=your_bybit_client_secret
ENCRYPTION_KEY=your_32_byte_hex_key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

生成 ENCRYPTION_KEY：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 测试清单

### ✅ 1. 小组功能测试

#### 1.1 小组列表页面
- [ ] 访问 `/groups`
- [ ] 验证右侧显示小组列表
- [ ] 验证小组标题可点击
- [ ] 点击小组标题，应跳转到 `/groups/[id]`

#### 1.2 小组主页
- [ ] 访问 `/groups/[id]`（使用实际的小组 ID）
- [ ] 验证显示小组头像（如果有）
- [ ] 验证显示小组名称和介绍
- [ ] 验证显示成员数
- [ ] 验证显示"加入小组"按钮（未加入时）
- [ ] 点击"加入小组"，验证成功加入
- [ ] 验证加入后显示"发新帖"和"退出小组"按钮
- [ ] 验证帖子排序切换（最新/热门）
- [ ] 验证右下角固定发帖按钮（仅成员可见）

#### 1.3 帖子排序
- [ ] 切换到"最新"标签，验证按时间降序
- [ ] 切换到"热门"标签，验证按综合分数排序
- [ ] 验证热门排序公式：`(like_count * 2 + comment_count * 1) / (1 + hours_since_created / 24)`

### ✅ 2. 发帖功能测试

#### 2.1 基础发帖
- [ ] 访问 `/groups/[id]/new`
- [ ] 验证需要登录才能发帖
- [ ] 填写标题和内容
- [ ] 点击"发布"，验证成功

#### 2.2 图片上传
- [ ] 在发帖页面点击"+ 添加图片"
- [ ] 选择一张图片（jpg/png/gif/webp）
- [ ] 验证图片上传成功并显示预览
- [ ] 验证可以上传多张图片
- [ ] 验证可以删除已上传的图片
- [ ] 验证超过 5MB 的图片被拒绝
- [ ] 发布帖子，验证图片在帖子中显示

#### 2.3 链接添加
- [ ] 在发帖页面输入链接 URL
- [ ] 点击"添加"按钮
- [ ] 验证链接预览（标题、描述、图片）自动加载
- [ ] 验证可以添加多个链接
- [ ] 验证可以删除链接
- [ ] 发布帖子，验证链接预览在帖子中显示

#### 2.4 投票功能
- [ ] 在发帖页面点击"+ 添加投票"
- [ ] 输入投票问题
- [ ] 添加至少 2 个选项
- [ ] 验证可以添加更多选项
- [ ] 验证可以删除选项（至少保留 2 个）
- [ ] 切换单选/多选模式
- [ ] 设置截止时间（可选）
- [ ] 发布帖子，验证投票在帖子中显示
- [ ] 验证可以投票（单选/多选）
- [ ] 验证投票结果实时更新

### ✅ 3. 交易所 OAuth 登录测试

#### 3.1 OAuth 授权流程
- [ ] 访问 `/exchange/auth`
- [ ] 验证需要登录
- [ ] 选择交易所（Binance 或 Bybit）
- [ ] 点击"使用 OAuth 授权"
- [ ] 验证跳转到交易所授权页面
- [ ] 完成授权，验证回调成功
- [ ] 验证跳转回设置页面

#### 3.2 连接状态
- [ ] 访问用户主页 `/u/[handle]`
- [ ] 验证显示"账户必需数据"卡片
- [ ] 验证显示已连接的交易所
- [ ] 验证显示"同步数据"按钮

### ✅ 4. 数据同步测试

#### 4.1 手动同步
- [ ] 在用户主页点击"同步数据"按钮
- [ ] 验证显示"同步中..."状态
- [ ] 验证同步完成后显示交易数据
- [ ] 验证显示以下指标：
  - 总交易次数
  - 盈利交易百分比
  - 平均盈利
  - 平均亏损
  - 平均持仓时间

#### 4.2 数据计算
- [ ] 验证所有 account_required_* 字段正确计算
- [ ] 验证数据存储在 `user_trading_data` 表
- [ ] 验证数据在用户主页正确显示

### ✅ 5. 用户主页集成测试

#### 5.1 账户数据展示
- [ ] 访问自己的用户主页 `/u/[handle]`
- [ ] 验证显示"账户必需数据"卡片（仅自己可见）
- [ ] 验证未绑定交易所时显示"绑定交易所"按钮
- [ ] 验证已绑定交易所时显示连接信息和数据
- [ ] 验证可以点击"同步数据"按钮

#### 5.2 数据展示
- [ ] 验证交易数据正确显示
- [ ] 验证多个交易所的数据分别显示
- [ ] 验证最后同步时间显示

## 常见问题排查

### 问题 1: 图片上传失败
- 检查 Supabase Storage bucket `posts` 是否创建
- 检查 bucket 权限设置
- 检查文件大小是否超过 5MB
- 检查文件类型是否支持

### 问题 2: OAuth 授权失败
- 检查环境变量是否正确配置
- 检查 OAuth 回调 URL 是否匹配
- 检查 `oauth_states` 表是否创建
- 检查交易所开发者平台配置

### 问题 3: 数据同步失败
- 检查 `user_exchange_connections` 表是否有连接记录
- 检查 `ENCRYPTION_KEY` 是否正确配置
- 检查交易所 API 是否可访问
- 查看服务器日志错误信息

### 问题 4: 投票功能不工作
- 检查 `polls` 和 `poll_votes` 表是否创建
- 检查 RLS 策略是否正确设置
- 检查投票触发器是否创建

### 问题 5: 小组功能不显示
- 检查 `groups` 表是否有数据
- 检查 `group_members` 表是否正确关联
- 检查 `member_count` 是否自动更新

## 测试数据准备

### 创建测试小组

在 Supabase SQL Editor 中运行：

```sql
INSERT INTO groups (id, name, subtitle, description, member_count)
VALUES 
  (gen_random_uuid(), 'BTC 内幕鲸鱼组', '专业 BTC 交易讨论', '这里是专业的 BTC 交易讨论组', 0),
  (gen_random_uuid(), '合约爆仓幸存者', '合约交易经验分享', '分享合约交易经验和教训', 0),
  (gen_random_uuid(), 'DeFi 长线仓位讨论区', 'DeFi 项目分析', '讨论 DeFi 项目的长期投资价值', 0);
```

### 创建测试帖子

在小组页面手动创建，或使用 API：

```sql
-- 需要先获取一个小组 ID 和用户 ID
INSERT INTO posts (group_id, title, content, author_handle, author_id, like_count, comment_count)
VALUES 
  ('your-group-id', '测试帖子标题', '这是测试帖子内容', 'test_user', 'your-user-id', 10, 5);
```

## 性能测试

- [ ] 测试大量帖子时的排序性能
- [ ] 测试图片上传的并发处理
- [ ] 测试数据同步的响应时间
- [ ] 测试热门排序算法的准确性

## 安全测试

- [ ] 验证未登录用户无法发帖
- [ ] 验证非小组成员无法发帖
- [ ] 验证 OAuth state 防 CSRF 攻击
- [ ] 验证图片上传文件类型限制
- [ ] 验证链接预览的 URL 验证

## 浏览器兼容性测试

- [ ] Chrome/Edge (最新版)
- [ ] Firefox (最新版)
- [ ] Safari (最新版)
- [ ] 移动端浏览器

## 完成测试后

如果所有测试通过，功能已准备就绪！

如有问题，请检查：
1. 数据库迁移是否全部完成
2. 环境变量是否正确配置
3. Supabase Storage 是否设置
4. 浏览器控制台是否有错误
5. 服务器日志是否有错误

