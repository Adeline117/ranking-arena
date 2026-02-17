# Arena 社交功能优化方案

> 审计日期: 2026-02-17  
> 审计范围: messages, groups, posts, inbox, following, notifications  
> 目标: 百万级用户高并发 · 数据库架构优化 · 推荐算法

---

## 维度1: 高并发优化（百万级用户）

### 1.1 N+1 查询问题

| 文件 | 行号(约) | 问题 | 建议 |
|------|----------|------|------|
| `app/api/following/route.ts` | L89-100 | 获取trader follows后，分别查`trader_sources`、`trader_snapshots`、`leaderboard_ranks` — 3次额外查询 | 用单次RPC或SQL JOIN合并为一次查询 |
| `app/api/following/route.ts` | L107-125 | `missingHandleIds`又发起额外的`leaderboard_ranks`查询做fallback | 在主查询中LEFT JOIN解决 |
| `app/groups/[id]/page.tsx` | L155-165 | 加载group后单独查`user_profiles`获取owner handle | 用JOIN或在groups表冗余owner_handle字段 |
| `app/groups/[id]/page.tsx` | L300-320 | `loadMembers`先查`group_members`再查`user_profiles` (N+1) | 用`.select('*, user_profiles(handle, avatar_url)')` 单次JOIN |
| `app/api/messages/route.ts` | L86-92 | GET每次都查`user_profiles`获取otherUser信息 | 缓存otherUser信息或在conversation表冗余 |

### 1.2 缺失分页

| 文件 | 行号(约) | 问题 | 建议 |
|------|----------|------|------|
| `app/my-posts/page.tsx` | L56 | `limit: '100'` 硬编码，无滚动加载 | 改为limit=20 + infinite scroll |
| `app/following/page.tsx` | L143 | 一次性加载全部关注列表（`/api/following?userId=`） | 添加分页参数 `?limit=50&offset=0`，前端infinite scroll |
| `app/components/inbox/NotificationsList.tsx` | L43 | 初始加载无limit参数(依赖后端默认值) | 明确传`?limit=20` |

### 1.3 缓存策略

| 组件 | 当前状态 | 建议 |
|------|----------|------|
| `/api/groups` | ✅ 已有Cache-Control `s-maxage=120` | 良好 |
| `/api/posts` | ✅ 已有server memory cache + Redis热帖缓存 | 良好 |
| `/api/following` | ❌ 无缓存，`force-dynamic` | 添加Redis缓存，TTL=60s，关注/取关时失效 |
| `/api/messages` (GET) | ❌ 无缓存，`force-dynamic` | 合理(实时性要求)，但otherUser信息可缓存 |
| `/api/conversations` | ❌ 每次全量查询 | Redis缓存会话列表，新消息时增量更新 |
| `/api/notifications` | ❌ 无缓存 | Redis缓存未读计数，TTL=30s |

### 1.4 实时消息实现分析

**当前实现**: 
- `usePresence` (lib/hooks/usePresence.ts): Supabase Realtime Presence，全局channel `presence:global`
- `useConversationMessages` (hooks/useConversationMessages.ts): Supabase postgres_changes监听INSERT/UPDATE
- `ConversationsList` (inbox/ConversationsList.tsx): 也监听postgres_changes

**问题**:
1. **全局Presence channel** (usePresence.ts L18): 所有用户共享`presence:global`，百万用户时Presence state极大
2. **DB heartbeat** (usePresence.ts L57-63): 每60秒POST `/api/presence` 更新DB — 百万用户 = 每秒~16,667次写入
3. **Realtime通道膨胀**: 每个会话页面订阅2个channel (INSERT + UPDATE filter)

**建议**:
```
1. Presence channel分片: 按用户ID哈希分到100-1000个channel
   如 `presence:${hashUserId(uid) % 1000}`
   
2. 降低DB heartbeat频率: 60s → 300s, 或改用Redis存储在线状态
   
3. 消息推送改用Redis Pub/Sub + SSE:
   - 发送消息时publish到 `msg:{conversationId}` channel
   - 客户端通过SSE订阅，替代Supabase Realtime的postgres_changes
   - 大幅降低Supabase Realtime连接数
```

### 1.5 Redis缓存层建议

```
Redis Key 设计:
├── user:following:{userId}          # 关注列表, TTL=120s
├── user:conversations:{userId}      # 会话列表, TTL=60s  
├── user:unread:{userId}             # 未读消息计数, TTL=30s
├── user:notifications:count:{userId}# 未读通知数, TTL=30s
├── presence:online                  # SET, 在线用户集合
├── presence:typing:{conversationId} # SET, 正在输入的用户
├── group:detail:{groupId}           # 小组详情, TTL=300s
├── group:members:{groupId}          # 成员列表, TTL=120s
├── hot_posts:top50                  # ✅ 已实现
└── post:reactions:{postId}          # 帖子反应计数, TTL=60s
```

### 1.6 连接池与读写分离

**当前问题**: 
- `app/api/following/route.ts` L40: 每次请求创建新的`createClient(SUPABASE_URL, SUPABASE_KEY)` 
- 多个API路由重复此模式

**建议**:
1. 统一使用`getSupabaseAdmin()` (lib/supabase/server.ts) — 它应该复用单例连接
2. Supabase已提供连接池(PgBouncer)，确认`?pgbouncer=true`已在连接字符串
3. 读写分离: Supabase Pro plan支持read replicas，读操作路由到replica

---

## 维度2: 数据库架构优化

### 2.1 索引优化

#### 🔴 关键: leaderboard_ranks source索引缺失

**问题**: `GROUP BY source` 全表扫描导致超时（30,074行, 25个source）

```sql
-- 迁移脚本 001: 添加leaderboard_ranks source索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_source 
  ON leaderboard_ranks (source);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_source_season 
  ON leaderboard_ranks (source, season_id);

-- 如果有按source统计的查询:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_source_trader 
  ON leaderboard_ranks (source, source_trader_id);
```

#### 🟡 消息系统索引

```sql
-- 迁移脚本 002: 消息系统索引优化

-- conversations: 按用户查找会话
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_user1 
  ON conversations (user1_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_user2 
  ON conversations (user2_id);

-- direct_messages: 按会话+时间查询（分页用）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_conversation_created 
  ON direct_messages (conversation_id, created_at DESC);

-- direct_messages: 未读消息计数
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_receiver_unread 
  ON direct_messages (receiver_id, read) WHERE read = false;
```

#### 🟡 社交功能索引

```sql
-- 迁移脚本 003: 社交功能索引

-- posts: 按热度排序 + 分组
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_hot 
  ON posts (group_id, hot_score DESC) WHERE group_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_created_desc 
  ON posts (created_at DESC);

-- notifications: 按用户+未读状态
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread 
  ON notifications (user_id, read, created_at DESC);

-- user_follows: 双向查询
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_following 
  ON user_follows (following_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_follower 
  ON user_follows (follower_id, created_at DESC);

-- trader_follows: 用户的关注列表
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_follows_user 
  ON trader_follows (user_id, created_at DESC);
```

### 2.2 表结构分析

| 表 | 评估 | 问题 | 建议 |
|----|------|------|------|
| `conversations` | ⚠️ | user1_id/user2_id排序约定(较小ID为user1)增加了复杂度 | 可接受，但要确保双向索引 |
| `direct_messages` | ⚠️ | 同时有sender_id和receiver_id + conversation_id，略冗余 | receiver_id可从conversation推导，但保留利于快速过滤未读 |
| `groups` | ✅ | member_count冗余计数 + trigger同步 | 良好模式 |
| `group_members` | ✅ | 有RLS + trigger | 良好 |
| `posts` | ✅ | 有hot_score + 评论计数 | 良好，建议添加缓存层 |
| `user_interactions` | ✅ | 已有target索引和user索引 | 可用于推荐算法 |

### 2.3 RLS策略效率

**已知问题**:
- `group_members`有RLS — 每次查询都会执行策略检查
- 高频读操作(如帖子列表)在RLS下性能下降

**建议**:
1. API路由中使用`getSupabaseAdmin()` (service role key) 绑定auth检查在应用层，绕过RLS
2. 确认当前是否已这样做 — 大部分API确实用service role key，✅ 正确
3. 客户端直接调用Supabase的地方(如`app/groups/[id]/page.tsx` L244-248 `supabase.from('group_members').select(...)`)会走RLS
   - **建议**: 将这些查询迁移到API路由，统一用server端admin client

### 2.4 完整SQL迁移脚本

```sql
-- ============================================
-- Arena Social Features: Database Migration
-- ============================================
-- Run with: psql $DATABASE_URL -f migration.sql
-- Note: Use CONCURRENTLY to avoid table locks

BEGIN;

-- 1. leaderboard_ranks 索引（解决GROUP BY source超时）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_source 
  ON leaderboard_ranks (source);

-- 2. 消息系统索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_user1 
  ON conversations (user1_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_user2 
  ON conversations (user2_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_conversation_created 
  ON direct_messages (conversation_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dm_receiver_unread 
  ON direct_messages (receiver_id, read) WHERE read = false;

-- 3. 帖子索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_hot 
  ON posts (group_id, hot_score DESC) WHERE group_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_created_desc 
  ON posts (created_at DESC);

-- 4. 通知索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread 
  ON notifications (user_id, read, created_at DESC);

-- 5. 关注索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_following 
  ON user_follows (following_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_follower 
  ON user_follows (follower_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_follows_user 
  ON trader_follows (user_id, created_at DESC);

-- 6. 推荐算法所需索引（user_interactions）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_interactions_action_target 
  ON user_interactions (action, target_type, target_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_interactions_user_action 
  ON user_interactions (user_id, action, created_at DESC);

COMMIT;
```

> ⚠️ 注意: `CREATE INDEX CONCURRENTLY` 不能在事务块中执行。实际运行时需去掉 `BEGIN/COMMIT`，逐条执行。

---

## 维度3: 推荐算法

### 3.1 当前排序逻辑

| 功能 | 文件 | 排序方式 |
|------|------|----------|
| 帖子Feed | `app/api/posts/route.ts` L60 | `created_at` / `hot_score` / `like_count`，支持加权排序 |
| 小组帖子 | `app/groups/[id]/hooks/useGroupPosts` | sortMode: hot/new/top |
| 关注列表 | `app/following/page.tsx` L206-220 | recent / roi / score 客户端排序 |
| 小组列表 | `app/api/groups/route.ts` L34 | `member_count DESC` 固定排序 |
| 相关小组 | `app/groups/[id]/page.tsx` L149 | RPC `get_related_groups` + fallback member_count |
| 通知 | `app/components/inbox/NotificationsList.tsx` | created_at DESC (服务端) |
| 会话 | `app/components/inbox/ConversationsList.tsx` | last_message_at DESC |

**问题**: 没有个性化推荐，所有用户看到相同排序。

### 3.2 user_interactions 表分析

已有表结构:
```
user_interactions:
  - user_id: uuid
  - target_type: text  (如 'post', 'trader', 'group', 'user')
  - target_id: text
  - action: text        (如 'view', 'like', 'follow', 'comment', 'share')
  - metadata: jsonb
  - created_at: timestamp
  
已有索引:
  - idx_interactions_target (target_type, target_id)
  - idx_interactions_user (user_id)
```

### 3.3 推荐算法方案

#### 方案A: 协同过滤（基于user_interactions）

```sql
-- 找到与当前用户行为相似的用户
-- 输入: 当前用户ID, 目标类型
CREATE OR REPLACE FUNCTION recommend_by_collaborative_filtering(
  p_user_id uuid,
  p_target_type text DEFAULT 'post',
  p_limit int DEFAULT 20
)
RETURNS TABLE(target_id text, score float) AS $$
BEGIN
  RETURN QUERY
  WITH my_targets AS (
    -- 当前用户交互过的目标
    SELECT DISTINCT ui.target_id
    FROM user_interactions ui
    WHERE ui.user_id = p_user_id
      AND ui.target_type = p_target_type
      AND ui.action IN ('like', 'comment', 'share', 'view')
  ),
  similar_users AS (
    -- 找到交互了相同目标的其他用户，按重叠度排名
    SELECT ui.user_id, COUNT(DISTINCT ui.target_id) as overlap
    FROM user_interactions ui
    JOIN my_targets mt ON ui.target_id = mt.target_id
    WHERE ui.user_id != p_user_id
      AND ui.target_type = p_target_type
      AND ui.action IN ('like', 'comment', 'share')
    GROUP BY ui.user_id
    ORDER BY overlap DESC
    LIMIT 100
  ),
  recommendations AS (
    -- 这些相似用户交互过、但当前用户没交互过的目标
    SELECT ui.target_id, 
           SUM(su.overlap) as score
    FROM user_interactions ui
    JOIN similar_users su ON ui.user_id = su.user_id
    WHERE ui.target_type = p_target_type
      AND ui.action IN ('like', 'comment', 'share')
      AND ui.target_id NOT IN (SELECT target_id FROM my_targets)
    GROUP BY ui.target_id
    ORDER BY score DESC
    LIMIT p_limit
  )
  SELECT r.target_id, r.score FROM recommendations r;
END;
$$ LANGUAGE plpgsql STABLE;
```

#### 方案B: 热度 + 个性化混合排序

```sql
-- 个性化Feed: 70%热度 + 30%个性化
CREATE OR REPLACE FUNCTION get_personalized_feed(
  p_user_id uuid,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  post_id uuid,
  final_score float
) AS $$
BEGIN
  RETURN QUERY
  WITH user_group_ids AS (
    -- 用户加入的小组
    SELECT group_id FROM group_members WHERE user_id = p_user_id
  ),
  user_followed_ids AS (
    -- 用户关注的人
    SELECT following_id FROM user_follows WHERE follower_id = p_user_id
  ),
  scored_posts AS (
    SELECT 
      p.id,
      COALESCE(p.hot_score, 0) * 0.7 as hot_component,
      -- 个性化加分
      CASE WHEN p.group_id IN (SELECT group_id FROM user_group_ids) THEN 20 ELSE 0 END +
      CASE WHEN p.author_id IN (SELECT following_id FROM user_followed_ids) THEN 30 ELSE 0 END +
      -- 基于历史交互: 如果用户经常看某小组的帖子，加分
      COALESCE((
        SELECT COUNT(*) * 5
        FROM user_interactions ui
        WHERE ui.user_id = p_user_id
          AND ui.target_type = 'post'
          AND ui.action IN ('like', 'comment')
          AND ui.target_id IN (
            SELECT id::text FROM posts WHERE group_id = p.group_id
          )
        LIMIT 10
      ), 0) as personalization_component
    FROM posts p
    WHERE p.created_at > NOW() - INTERVAL '7 days'
  )
  SELECT 
    sp.id,
    sp.hot_component + sp.personalization_component * 0.3 as final_score
  FROM scored_posts sp
  ORDER BY final_score DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql STABLE;
```

#### 方案C: 基于内容的小组推荐（增强现有 get_related_groups）

```sql
-- 基于用户行为推荐小组
CREATE OR REPLACE FUNCTION recommend_groups_for_user(
  p_user_id uuid,
  p_limit int DEFAULT 10
)
RETURNS TABLE(
  group_id uuid,
  group_name text,
  score float,
  reason text
) AS $$
BEGIN
  RETURN QUERY
  WITH my_groups AS (
    SELECT gm.group_id FROM group_members gm WHERE gm.user_id = p_user_id
  ),
  -- 找关注的人加入了哪些小组
  follow_based AS (
    SELECT gm.group_id, COUNT(*) * 10 as score, 'followed_users_joined' as reason
    FROM group_members gm
    JOIN user_follows uf ON gm.user_id = uf.following_id
    WHERE uf.follower_id = p_user_id
      AND gm.group_id NOT IN (SELECT group_id FROM my_groups)
    GROUP BY gm.group_id
  ),
  -- 找和当前用户同组的人还加入了哪些其他组
  overlap_based AS (
    SELECT gm2.group_id, COUNT(DISTINCT gm2.user_id) * 5 as score, 'members_overlap' as reason
    FROM group_members gm1
    JOIN group_members gm2 ON gm1.user_id = gm2.user_id
    WHERE gm1.group_id IN (SELECT group_id FROM my_groups)
      AND gm2.group_id NOT IN (SELECT group_id FROM my_groups)
      AND gm1.user_id != p_user_id
    GROUP BY gm2.group_id
  ),
  combined AS (
    SELECT COALESCE(f.group_id, o.group_id) as gid,
           COALESCE(f.score, 0) + COALESCE(o.score, 0) as total_score,
           COALESCE(f.reason, o.reason) as top_reason
    FROM follow_based f
    FULL OUTER JOIN overlap_based o ON f.group_id = o.group_id
  )
  SELECT c.gid, g.name, c.total_score, c.top_reason
  FROM combined c
  JOIN groups g ON g.id = c.gid
  ORDER BY c.total_score DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;
```

### 3.4 实施路线图

| 阶段 | 任务 | 预期效果 | 工期 |
|------|------|----------|------|
| Phase 1 | 执行SQL迁移（索引） | GROUP BY source不再超时，查询提速50%+ | 1天 |
| Phase 2 | Following API添加分页 + Redis缓存 | 响应时间 <100ms | 2天 |
| Phase 3 | Presence channel分片 + 降低heartbeat频率 | Realtime连接数降低1000x | 3天 |
| Phase 4 | 个性化Feed (方案B) | 用户engagement提升 | 5天 |
| Phase 5 | 协同过滤推荐 (方案A+C) | 内容发现效率提升 | 5天 |

### 3.5 interaction tracking 增强建议

当前`user_interactions`表需要在更多地方埋点:

| 文件 | 位置 | 建议track的action |
|------|------|-------------------|
| `app/groups/[id]/page.tsx` | 进入小组页 | `{action:'view', target_type:'group', target_id}` |
| `app/post/[id]/PostDetailClient.tsx` | 查看帖子 | `{action:'view', target_type:'post', target_id}` |
| `app/messages/[conversationId]/page.tsx` | 打开会话 | `{action:'message', target_type:'user', target_id}` |
| `app/following/page.tsx` | 点击关注项 | `{action:'click', target_type:'trader/user', target_id}` |
| Group post scroll | 帖子曝光(viewport) | `{action:'impression', target_type:'post', target_id}` |

---

## 附录: 快速修复清单 (Quick Wins)

1. **[Critical]** 运行索引迁移SQL — 立即解决leaderboard_ranks超时
2. **[High]** `app/api/following/route.ts`: 合并3次trader查询为单次SQL JOIN
3. **[High]** `app/groups/[id]/page.tsx` L300-320: loadMembers改用JOIN
4. **[Medium]** `app/my-posts/page.tsx` L56: limit 100→20 + 无限滚动
5. **[Medium]** `app/following/page.tsx`: 添加服务端分页
6. **[Low]** usePresence全局channel → 分片channel
