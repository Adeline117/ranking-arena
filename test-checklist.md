# 功能测试检查清单

## ✅ 构建状态
- [x] TypeScript 编译通过
- [x] Next.js 构建成功
- [x] 所有类型错误已修复

## 📋 数据库迁移检查

请在 Supabase Dashboard 的 SQL Editor 中运行以下脚本（按顺序）：

1. [ ] `scripts/update_groups_table.sql` - 更新小组表
2. [ ] `scripts/update_posts_table.sql` - 更新帖子表  
3. [ ] `scripts/create_polls_table.sql` - 创建投票表
4. [ ] `scripts/create_oauth_states_table.sql` - 创建 OAuth states 表

## 🗄️ Supabase Storage 设置

1. [ ] 创建 bucket: `posts`
2. [ ] 设置权限：
   - Public: 允许读取
   - Authenticated: 允许上传

## 🧪 功能测试

### 1. 小组功能
- [ ] 访问 `/groups` - 查看小组列表
- [ ] 点击小组标题 - 跳转到小组主页
- [ ] 查看小组头像、名称、介绍
- [ ] 点击"加入小组"按钮
- [ ] 验证加入后显示"发新帖"和"退出小组"
- [ ] 测试帖子排序：最新/热门切换
- [ ] 验证右下角固定发帖按钮（仅成员可见）

### 2. 发帖功能
- [ ] 访问 `/groups/[id]/new` - 发帖页面
- [ ] 填写标题和内容
- [ ] 上传图片（多图）
- [ ] 添加链接并验证预览
- [ ] 创建投票（单选/多选）
- [ ] 发布帖子
- [ ] 验证帖子中显示图片、链接、投票

### 3. 交易所 OAuth（可选，需要配置）
- [ ] 访问 `/exchange/auth`
- [ ] 选择交易所
- [ ] 测试 OAuth 授权流程

### 4. 用户主页
- [ ] 访问 `/u/[handle]` - 自己的主页
- [ ] 验证显示"账户必需数据"卡片
- [ ] 测试"同步数据"功能

## 🔍 API 端点测试

### 图片上传 API
```bash
curl -X POST http://localhost:3000/api/posts/upload-image \
  -F "file=@test-image.jpg" \
  -F "userId=your-user-id"
```

### 链接预览 API
```bash
curl "http://localhost:3000/api/posts/link-preview?url=https://example.com"
```

### 数据同步 API
```bash
curl -X POST http://localhost:3000/api/exchange/sync \
  -H "Content-Type: application/json" \
  -d '{"userId":"your-user-id","exchange":"binance"}'
```

## 🐛 常见问题

如果遇到问题，请检查：

1. **数据库表不存在**
   - 运行所有 SQL 迁移脚本

2. **图片上传失败**
   - 检查 Supabase Storage bucket 是否创建
   - 检查文件大小（最大 5MB）
   - 检查文件类型（jpg/png/gif/webp）

3. **OAuth 授权失败**
   - 检查环境变量是否配置
   - 检查回调 URL 是否匹配

4. **帖子不显示**
   - 检查 `posts` 表是否有数据
   - 检查 RLS 策略是否正确

## 📝 测试数据

### 创建测试小组
```sql
INSERT INTO groups (id, name, subtitle, description, member_count)
VALUES 
  (gen_random_uuid(), '测试小组1', '这是测试小组', '用于测试的小组描述', 0);
```

### 创建测试帖子
```sql
-- 需要先获取一个小组 ID 和用户 ID
INSERT INTO posts (group_id, title, content, author_handle, author_id, like_count, comment_count)
VALUES 
  ('your-group-id', '测试帖子', '这是测试内容', 'test_user', 'your-user-id', 10, 5);
```

## ✅ 完成测试

完成所有测试后，功能应该可以正常使用！

如有问题，请查看 `docs/TESTING_GUIDE.md` 获取详细说明。

