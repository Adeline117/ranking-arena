-- 翻译缓存表
-- 用于存储帖子/评论的翻译结果，避免重复调用GPT

CREATE TABLE IF NOT EXISTS translation_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- 内容类型: post_title, post_content, comment
  content_type VARCHAR(20) NOT NULL,
  -- 关联ID（帖子ID或评论ID）
  content_id UUID NOT NULL,
  -- 原文的哈希值（用于检测内容变化）
  content_hash VARCHAR(64) NOT NULL,
  -- 原始语言
  source_lang VARCHAR(5) NOT NULL,
  -- 目标语言
  target_lang VARCHAR(5) NOT NULL,
  -- 翻译后的文本
  translated_text TEXT NOT NULL,
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- 唯一约束：同一内容+目标语言只存一份
  UNIQUE(content_type, content_id, target_lang)
);

-- 索引：加速查询
CREATE INDEX IF NOT EXISTS idx_translation_cache_lookup 
  ON translation_cache(content_type, content_id, target_lang);
CREATE INDEX IF NOT EXISTS idx_translation_cache_content_hash 
  ON translation_cache(content_hash);

-- RLS 策略（翻译缓存公开可读，由服务端写入）
ALTER TABLE translation_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Translation cache is readable by everyone" ON translation_cache;
CREATE POLICY "Translation cache is readable by everyone"
  ON translation_cache FOR SELECT
  USING (true);

-- 只有 service_role 可以写入
DROP POLICY IF EXISTS "Service role can manage translation cache" ON translation_cache;
CREATE POLICY "Service role can manage translation cache"
  ON translation_cache FOR ALL
  USING (true)
  WITH CHECK (true);

-- 批量获取翻译缓存的函数
CREATE OR REPLACE FUNCTION get_translations_batch(
  p_content_type VARCHAR(20),
  p_content_ids UUID[],
  p_target_lang VARCHAR(5)
)
RETURNS TABLE (
  content_id UUID,
  translated_text TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT tc.content_id, tc.translated_text
  FROM translation_cache tc
  WHERE tc.content_type = p_content_type
    AND tc.content_id = ANY(p_content_ids)
    AND tc.target_lang = p_target_lang;
END;
$$ LANGUAGE plpgsql;

-- 授予执行权限
GRANT EXECUTE ON FUNCTION get_translations_batch(VARCHAR, UUID[], VARCHAR) TO authenticated;
GRANT EXECUTE ON FUNCTION get_translations_batch(VARCHAR, UUID[], VARCHAR) TO anon;
GRANT EXECUTE ON FUNCTION get_translations_batch(VARCHAR, UUID[], VARCHAR) TO service_role;

-- 完成

