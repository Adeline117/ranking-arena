# 聊天设置功能设计

## 1. 数据模型

### user_settings 表
```sql
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),

  -- 通知设置
  notify_new_message BOOLEAN DEFAULT true,
  notify_mentions_only BOOLEAN DEFAULT false,
  notify_dm_only BOOLEAN DEFAULT false,

  -- 隐私设置
  dm_permission TEXT DEFAULT 'all' CHECK (dm_permission IN ('all', 'mutual', 'none')),

  -- 显示设置
  time_format TEXT DEFAULT '24h' CHECK (time_format IN ('12h', '24h')),
  language TEXT DEFAULT 'zh' CHECK (language IN ('zh', 'en')),
  show_read_receipts BOOLEAN DEFAULT true,

  -- 内容设置
  sensitive_filter_level TEXT DEFAULT 'medium' CHECK (sensitive_filter_level IN ('low', 'medium', 'high')),
  show_link_preview BOOLEAN DEFAULT true,

  -- 体验设置
  enter_to_send BOOLEAN DEFAULT true,
  auto_scroll BOOLEAN DEFAULT true,
  collapse_long_messages BOOLEAN DEFAULT true,

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own settings"
  ON user_settings FOR ALL
  USING (user_id = auth.uid());

-- 自动更新 updated_at
CREATE TRIGGER update_user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

### conversation_settings 表
```sql
CREATE TABLE conversation_settings (
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),

  is_muted BOOLEAN DEFAULT false,
  is_pinned BOOLEAN DEFAULT false,
  custom_nickname TEXT,  -- 给对方设置的备注名

  PRIMARY KEY (conversation_id, user_id)
);

-- RLS
ALTER TABLE conversation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own conversation settings"
  ON conversation_settings FOR ALL
  USING (user_id = auth.uid());
```

---

## 2. 默认值与迁移策略

### 默认值
```typescript
const DEFAULT_SETTINGS: UserSettings = {
  // 通知
  notify_new_message: true,
  notify_mentions_only: false,
  notify_dm_only: false,

  // 隐私
  dm_permission: 'all',

  // 显示
  time_format: '24h',
  language: 'zh',
  show_read_receipts: true,

  // 内容
  sensitive_filter_level: 'medium',
  show_link_preview: true,

  // 体验
  enter_to_send: true,
  auto_scroll: true,
  collapse_long_messages: true,
}
```

### 迁移策略
```sql
-- 新用户：首次访问设置页时自动创建
INSERT INTO user_settings (user_id)
VALUES (auth.uid())
ON CONFLICT (user_id) DO NOTHING;

-- 新增字段时：使用 DEFAULT 值，不影响现有行
ALTER TABLE user_settings
ADD COLUMN new_setting BOOLEAN DEFAULT true;

-- 向后兼容：应用代码中使用 ?? 运算符
const enterToSend = settings.enter_to_send ?? true;
```

---

## 3. 前端读取与缓存

### useUserSettings hook
```typescript
import { useCallback, useEffect } from 'react'
import useSWR from 'swr'
import { supabase } from '@/lib/supabase/client'

const DEFAULT_SETTINGS = { /* ... */ }

export function useUserSettings() {
  const { data, error, mutate } = useSWR(
    'user-settings',
    async () => {
      const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .single()

      if (error && error.code === 'PGRST116') {
        // 不存在，创建默认设置
        const { data: created } = await supabase
          .from('user_settings')
          .insert({ user_id: (await supabase.auth.getUser()).data.user?.id })
          .select()
          .single()
        return created
      }

      return data
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000, // 1分钟内不重复请求
    }
  )

  // 乐观更新
  const updateSetting = useCallback(async <K extends keyof UserSettings>(
    key: K,
    value: UserSettings[K]
  ) => {
    // 1. 立即更新本地
    mutate({ ...data, [key]: value }, false)

    // 2. 后台同步
    const { error } = await supabase
      .from('user_settings')
      .update({ [key]: value })
      .eq('user_id', data.user_id)

    // 3. 失败回滚
    if (error) {
      mutate(data, false)
      throw error
    }
  }, [data, mutate])

  return {
    settings: data ?? DEFAULT_SETTINGS,
    isLoading: !data && !error,
    error,
    updateSetting,
  }
}
```

### 跨设备同步
```typescript
// 使用 Supabase Realtime 监听设置变更
useEffect(() => {
  const channel = supabase
    .channel('user-settings-changes')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_settings',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        mutate(payload.new, false)
      }
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}, [userId, mutate])
```

---

## 4. 权限策略

### RLS 策略
```sql
-- user_settings: 只能读写自己的
CREATE POLICY "user_settings_own" ON user_settings
  FOR ALL USING (user_id = auth.uid());

-- conversation_settings: 只能操作自己参与的会话
CREATE POLICY "conversation_settings_own" ON conversation_settings
  FOR ALL USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations
      WHERE id = conversation_settings.conversation_id
      AND (user1_id = auth.uid() OR user2_id = auth.uid())
    )
  );
```

### API 层校验
```typescript
// app/api/settings/route.ts
export async function PUT(request: Request) {
  const user = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  // 校验字段
  const allowedFields = [
    'notify_new_message', 'notify_mentions_only', 'dm_permission',
    'time_format', 'language', 'show_read_receipts', 'enter_to_send',
    'auto_scroll', 'collapse_long_messages'
  ]

  const updates = Object.fromEntries(
    Object.entries(body).filter(([key]) => allowedFields.includes(key))
  )

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields' }, { status: 400 })
  }

  const { error } = await supabase
    .from('user_settings')
    .update(updates)
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
```

---

## 5. 测试用例清单

| # | 用例 | 类型 |
|---|------|------|
| 1 | 首次访问创建默认设置 | 功能 |
| 2 | 修改设置立即生效 | 功能 |
| 3 | 刷新后设置保持 | 持久化 |
| 4 | 跨设备设置同步 | 同步 |
| 5 | dm_permission='none'立即生效 | 权限 |
| 6 | 静音会话不收通知 | 通知 |
| 7 | 12h/24h时间格式切换 | 显示 |
| 8 | 中英文切换影响全站 | 显示 |
| 9 | 隐藏已读回执后对方看不到 | 隐私 |
| 10 | 敏感词过滤等级生效 | 内容 |
| 11 | 链接预览开关生效 | 内容 |
| 12 | Enter发送/换行切换 | 体验 |
| 13 | 长消息折叠开关 | 体验 |
| 14 | 会话静音/置顶独立生效 | 会话 |
| 15 | 设置API权限验证 | 安全 |
| 16 | 无效值拒绝 | 校验 |
| 17 | 并发修改不冲突 | 并发 |
| 18 | 网络断开重连后同步 | 网络 |
| 19 | 新增设置字段向后兼容 | 兼容 |
| 20 | 设置导出/重置 | 功能 |

---

## 6. 设置项详解

### 通知设置
| 设置 | 说明 | 默认值 |
|------|------|--------|
| notify_new_message | 新消息通知开关 | true |
| notify_mentions_only | 仅@我时通知 | false |
| notify_dm_only | 仅私聊通知 | false |

### 隐私设置
| 设置 | 说明 | 选项 |
|------|------|------|
| dm_permission | 谁能私聊我 | 'all', 'mutual', 'none' |

### 显示设置
| 设置 | 说明 | 选项 |
|------|------|------|
| time_format | 时间格式 | '12h', '24h' |
| language | 语言 | 'zh', 'en' |
| show_read_receipts | 显示已读状态 | true/false |

### 内容设置
| 设置 | 说明 | 选项 |
|------|------|------|
| sensitive_filter_level | 敏感词过滤等级 | 'low', 'medium', 'high' |
| show_link_preview | 链接预览 | true/false |

### 体验设置
| 设置 | 说明 | 默认值 |
|------|------|--------|
| enter_to_send | Enter发送（Shift+Enter换行） | true |
| auto_scroll | 新消息自动滚动 | true |
| collapse_long_messages | 长消息折叠 | true |

### 会话级设置
| 设置 | 说明 | 默认值 |
|------|------|--------|
| is_muted | 静音此会话 | false |
| is_pinned | 置顶此会话 | false |
| custom_nickname | 对方备注名 | null |
