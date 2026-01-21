# Row Level Security (RLS) 策略文档

本文档记录了 Arena 项目中所有 Supabase 表的 RLS 策略配置。

## 概览

| 表名 | RLS 状态 | SELECT | INSERT | UPDATE | DELETE |
|------|----------|--------|--------|--------|--------|
| `user_profiles` | 启用 | 公开 | 仅自己 | 仅自己 | 仅自己 |
| `posts` | 启用 | 公开 | 仅自己 | 仅自己 | 作者/群管理员/站点管理员 |
| `comments` | 启用 | 公开 | 仅自己 | 仅自己 | 作者/群管理员/站点管理员 |
| `user_follows` | 启用 | 公开 | 仅自己 | - | 仅自己 |
| `notifications` | 启用 | 仅自己 | service_role/自己 | 仅自己 | 仅自己 |
| `alert_configs` | 启用 | 仅自己 | 仅自己 | 仅自己 | 仅自己 |
| `risk_alerts` | 启用 | 仅自己 | service_role | - | 仅自己 |
| `push_subscriptions` | 启用 | 仅自己 | 仅自己 | 仅自己 | 仅自己 |
| `push_notification_logs` | 启用 | service_role | service_role | - | - |
| `groups` | 启用 | 公开 | 已认证 | owner/admin | owner |
| `group_members` | 启用 | 公开 | owner/admin | owner/admin | owner/admin/自己 |
| `group_applications` | 启用 | 申请人/群管理员/站点管理员 | 已认证 | 群管理员/站点管理员 | - |
| `subscriptions` | 启用 | 仅自己 | service_role | service_role | - |
| `pro_official_groups` | 启用 | 付费用户 | service_role | - | - |

---

## 详细策略说明

### 1. user_profiles（用户资料）

```sql
-- 公开可见
CREATE POLICY "User profiles are viewable by everyone"
  ON user_profiles FOR SELECT USING (true);

-- 只能创建自己的资料
CREATE POLICY "Users can insert their own profile"
  ON user_profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- 只能修改自己的资料
CREATE POLICY "Users can update their own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 只能删除自己的资料
CREATE POLICY "Users can delete their own profile"
  ON user_profiles FOR DELETE USING (auth.uid() = id);
```

**安全考虑**：
- 用户资料公开可见（头像、昵称等）
- 敏感字段（email）在应用层过滤
- 用户无法修改他人资料

---

### 2. posts（帖子）

```sql
-- 公开可见
CREATE POLICY "Posts are viewable by everyone"
  ON posts FOR SELECT USING (true);

-- 只能创建自己的帖子
CREATE POLICY "Authenticated users can create posts"
  ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);

-- 只能修改自己的帖子
CREATE POLICY "Users can update their own posts"
  ON posts FOR UPDATE
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- 作者/群管理员/站点管理员可删除（00012 修复）
CREATE POLICY "Authors and group admins can delete posts"
  ON posts FOR DELETE
  USING (
    auth.uid() = author_id
    OR (group_id IS NOT NULL AND is_group_admin(group_id))
    OR is_site_admin()
  );
```

**安全考虑**：
- 群组管理员可删除群内违规帖子
- 站点管理员可删除任何帖子

---

### 3. comments（评论）

```sql
-- 公开可见
CREATE POLICY "Comments are viewable by everyone"
  ON comments FOR SELECT USING (true);

-- 只能创建自己的评论
CREATE POLICY "Authenticated users can create comments"
  ON comments FOR INSERT WITH CHECK (auth.uid() = author_id);

-- 只能修改自己的评论
CREATE POLICY "Users can update their own comments"
  ON comments FOR UPDATE
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- 作者/群管理员/站点管理员可删除（00012 修复）
CREATE POLICY "Authors and group admins can delete comments"
  ON comments FOR DELETE
  USING (
    auth.uid() = author_id
    OR EXISTS (
      SELECT 1 FROM posts p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE p.id = comments.post_id
      AND p.group_id IS NOT NULL
      AND gm.user_id = auth.uid()
      AND gm.role IN ('owner', 'admin')
    )
    OR is_site_admin()
  );
```

---

### 4. notifications（通知）

```sql
-- 只能查看自己的通知
CREATE POLICY "Users can view their own notifications"
  ON notifications FOR SELECT USING (auth.uid() = user_id);

-- 只有 service_role 或用户自己可插入（00012 修复）
CREATE POLICY "Only service role can insert notifications"
  ON notifications FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR auth.uid() = user_id
  );

-- 只能修改自己的通知（如标记已读）
CREATE POLICY "Users can update their own notifications"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

**安全修复（00012）**：
- 原策略允许任何认证用户给任何人插入通知
- 修复后只有 service_role 或用户自己可插入

---

### 5. risk_alerts（风险预警）

```sql
-- 只能查看自己的预警
CREATE POLICY "Users can view their own risk alerts"
  ON risk_alerts FOR SELECT USING (auth.uid() = user_id);

-- 只有 service_role 可插入（00012 修复）
CREATE POLICY "Only service role can insert risk alerts"
  ON risk_alerts FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
```

**安全修复（00012）**：
- 风险预警只能由系统（Cron 任务）创建
- 防止用户伪造风险预警

---

### 6. group_applications（群组申请）

```sql
-- 申请人/群管理员/站点管理员可查看（00012 修复）
CREATE POLICY "Group admins can view applications"
  ON group_applications FOR SELECT
  USING (
    auth.uid() = applicant_id
    OR is_group_admin(group_id)
    OR is_site_admin()
  );

-- 群管理员/站点管理员可审核（00012 修复）
CREATE POLICY "Group admins can update applications"
  ON group_applications FOR UPDATE
  USING (is_group_admin(group_id) OR is_site_admin())
  WITH CHECK (is_group_admin(group_id) OR is_site_admin());
```

**安全修复（00012）**：
- 原策略只允许站点管理员审核
- 修复后群组 owner/admin 也可审核自己群的申请

---

### 7. pro_official_groups（Pro 官方群组）

```sql
-- 所有付费用户可访问（00012 修复）
CREATE POLICY "Pro official groups are viewable by premium members"
  ON pro_official_groups FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM subscriptions
      WHERE user_id = auth.uid()
      AND tier IN ('pro', 'elite', 'enterprise')
      AND status = 'active'
    )
  );
```

**安全修复（00012）**：
- 原策略只检查 `tier = 'pro'`
- 修复后 elite/enterprise 用户也可访问

---

## 辅助函数

以下函数用于简化 RLS 策略定义（00012 添加）：

```sql
-- 检查是否为群组管理员
CREATE OR REPLACE FUNCTION is_group_admin(p_group_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id
    AND user_id = auth.uid()
    AND role IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 检查是否为站点管理员
CREATE OR REPLACE FUNCTION is_site_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 检查是否为付费用户
CREATE OR REPLACE FUNCTION is_premium_user()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM subscriptions
    WHERE user_id = auth.uid()
    AND tier IN ('pro', 'elite', 'enterprise')
    AND status = 'active'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
```

---

## 性能优化索引

以下索引用于加速 RLS 查询（00012 添加）：

```sql
-- 群组成员角色检查
CREATE INDEX IF NOT EXISTS idx_group_members_user_role
  ON group_members(user_id, group_id, role);

-- 站点管理员检查
CREATE INDEX IF NOT EXISTS idx_user_profiles_role_admin
  ON user_profiles(id) WHERE role = 'admin';

-- 付费用户检查
CREATE INDEX IF NOT EXISTS idx_subscriptions_active_premium
  ON subscriptions(user_id)
  WHERE status = 'active' AND tier IN ('pro', 'elite', 'enterprise');
```

---

## 迁移文件对照

| 迁移文件 | 内容 |
|----------|------|
| `00010_rls_policies.sql` | 基础 RLS 策略定义 |
| `00012_fix_rls_security.sql` | 安全修复（致命漏洞修复、群组权限增强） |

---

## 安全检查清单

### PR 审查时确认：

- [ ] 新表是否启用了 RLS？
- [ ] SELECT 策略是否限制了敏感数据访问？
- [ ] INSERT 策略是否验证了 `auth.uid()`？
- [ ] UPDATE 策略是否同时使用 USING 和 WITH CHECK？
- [ ] DELETE 策略是否考虑了管理员权限？
- [ ] 是否添加了必要的性能索引？

---

最后更新: 2026-01-21
