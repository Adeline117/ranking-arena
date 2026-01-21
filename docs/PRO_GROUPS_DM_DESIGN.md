# Pro群组+私聊功能设计

## 1. 数据模型

### 现有表（已实现）
```sql
-- 私聊会话
conversations (
  id UUID PRIMARY KEY,
  user1_id UUID REFERENCES auth.users(id),
  user2_id UUID REFERENCES auth.users(id),
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT user_order CHECK (user1_id < user2_id)
)

-- 私聊消息
direct_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  sender_id UUID REFERENCES auth.users(id),
  receiver_id UUID REFERENCES auth.users(id),
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

-- Pro官方群
pro_official_groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  max_members INTEGER DEFAULT 500,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

pro_official_group_members (
  group_id UUID REFERENCES pro_official_groups(id),
  user_id UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
)
```

### 待补充表
```sql
-- 已读回执
CREATE TABLE read_receipts (
  conversation_id UUID REFERENCES conversations(id),
  user_id UUID REFERENCES auth.users(id),
  last_read_at TIMESTAMPTZ,
  last_read_message_id UUID,
  PRIMARY KEY (conversation_id, user_id)
);

-- 用户屏蔽
CREATE TABLE user_blocks (
  blocker_id UUID REFERENCES auth.users(id),
  blocked_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- 索引
CREATE INDEX idx_read_receipts_user ON read_receipts(user_id);
CREATE INDEX idx_user_blocks_blocked ON user_blocks(blocked_id);
```

---

## 2. 关键业务流程

### Pro自动入群
```
触发点：Stripe webhook checkout.session.completed
         ↓
调用 joinProOfficialGroup(userId)
         ↓
查询可用Pro群（member_count < max_members）
         ↓
INSERT pro_official_group_members
         ↓
UPDATE groups SET member_count = member_count + 1
```

**代码位置**：
- Webhook处理：`app/api/webhook/stripe/route.ts`
- 入群API：`app/api/pro-official-group/route.ts`

### 发起DM（幂等）
```
用户A点击"私信"用户B
         ↓
POST /api/messages/start { targetUserId: B }
         ↓
检查B的dm_permission设置
         ↓
检查是否互相关注（若required）
         ↓
get_or_create_conversation(A, B) -- 幂等
         ↓
返回 conversation_id
         ↓
跳转 /messages/{conversation_id}
```

**代码位置**：
- 发起会话：`app/api/messages/start/route.ts`
- 按钮组件：`app/components/UI/MessageButton.tsx`

### 发送消息
```
用户输入 → 按下发送
         ↓
POST /api/messages { conversationId, content }
         ↓
INSERT direct_messages
         ↓
Trigger: update_conversation_on_message()
         ↓
Trigger: create_message_notification()
         ↓
Supabase Realtime 广播
         ↓
对方客户端收到 INSERT 事件
         ↓
UI 追加新消息
```

**代码位置**：
- 发送消息：`app/api/messages/route.ts`
- 实时订阅：`lib/hooks/useRealtime.ts`
- 消息页面：`app/messages/[conversationId]/page.tsx`

---

## 3. 安全与权限

### RLS策略要点
```sql
-- direct_messages
CREATE POLICY "Users can view own messages"
  ON direct_messages FOR SELECT
  USING (sender_id = auth.uid() OR receiver_id = auth.uid());

CREATE POLICY "Users can send messages"
  ON direct_messages FOR INSERT
  WITH CHECK (sender_id = auth.uid());

CREATE POLICY "Receivers can mark read"
  ON direct_messages FOR UPDATE
  USING (receiver_id = auth.uid())
  WITH CHECK (receiver_id = auth.uid());

-- pro_official_group_members
CREATE POLICY "Public read"
  ON pro_official_group_members FOR SELECT
  USING (true);

CREATE POLICY "Pro users can join"
  ON pro_official_group_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM subscriptions
      WHERE user_id = auth.uid()
      AND tier = 'pro'
      AND status IN ('active', 'trialing')
    )
  );
```

### 服务端校验
```typescript
// 每次API调用必须验证
async function validateMessagePermission(senderId: string, receiverId: string) {
  // 1. 检查接收方的dm_permission设置
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('dm_permission')
    .eq('id', receiverId)
    .single()

  if (profile.dm_permission === 'none') {
    throw new Error('该用户不接受私信')
  }

  // 2. 若设置为'mutual'，检查互关
  if (profile.dm_permission === 'mutual') {
    const isMutual = await checkMutualFollow(senderId, receiverId)
    if (!isMutual) {
      throw new Error('仅允许互相关注的用户私信')
    }
  }

  // 3. 检查是否被屏蔽
  const { data: blocked } = await supabase
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', receiverId)
    .eq('blocked_id', senderId)
    .single()

  if (blocked) {
    throw new Error('无法发送消息')
  }

  // 4. 检查消息数量限制（非互关3条）
  if (profile.dm_permission === 'all') {
    const isMutual = await checkMutualFollow(senderId, receiverId)
    if (!isMutual) {
      const count = await getUnrepliedMessageCount(senderId, receiverId)
      if (count >= 3) {
        throw new Error('请等待对方回复后再发送更多消息')
      }
    }
  }
}
```

---

## 4. 性能优化

### 索引
```sql
CREATE INDEX idx_dm_conversation ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX idx_dm_unread ON direct_messages(receiver_id) WHERE read = false;
CREATE INDEX idx_conversations_user ON conversations(user1_id, last_message_at DESC);
CREATE INDEX idx_conversations_user2 ON conversations(user2_id, last_message_at DESC);
```

### 分页策略
```typescript
// 会话列表：按 last_message_at 倒序，每页 20
const { data: conversations } = await supabase
  .from('conversations')
  .select('*')
  .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
  .order('last_message_at', { ascending: false })
  .range(offset, offset + 19)

// 消息列表：按 created_at 倒序，每页 50，支持向上加载更多
const { data: messages } = await supabase
  .from('direct_messages')
  .select('*')
  .eq('conversation_id', conversationId)
  .order('created_at', { ascending: false })
  .range(0, 49)
```

---

## 5. 端到端测试用例

| # | 用例 | 严重度 |
|---|------|--------|
| 1 | Pro购买后自动加入官方群 | 致命 |
| 2 | Free用户看不到Pro群入口 | 高 |
| 3 | 发起私聊创建新会话 | 高 |
| 4 | 同两人只存在一个会话（幂等） | 高 |
| 5 | 消息实时推送到对方 | 高 |
| 6 | 标记消息已读 | 中 |
| 7 | 被屏蔽用户无法发消息 | 高 |
| 8 | dm_permission='none'时拒绝所有DM | 高 |
| 9 | dm_permission='mutual'只允许互关 | 高 |
| 10 | 非互关3条消息限制 | 中 |
| 11 | 断网后恢复消息不丢失 | 高 |
| 12 | 并发发送消息顺序正确 | 中 |
| 13 | 刷新后消息状态一致 | 高 |
| 14 | Pro到期后移出官方群 | 高 |
| 15 | 删除会话后历史不可恢复 | 中 |

---

## 6. 相关文件

| 组件/API | 路径 |
|----------|------|
| 消息发送API | `app/api/messages/route.ts` |
| 发起会话API | `app/api/messages/start/route.ts` |
| 会话列表API | `app/api/conversations/route.ts` |
| Pro群组API | `app/api/pro-official-group/route.ts` |
| 消息列表页 | `app/messages/page.tsx` |
| 会话详情页 | `app/messages/[conversationId]/page.tsx` |
| 消息按钮 | `app/components/UI/MessageButton.tsx` |
| 实时订阅 | `lib/hooks/useRealtime.ts` |
| DB Schema | `scripts/setup_user_messaging.sql` |
