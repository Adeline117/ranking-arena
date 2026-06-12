-- Migration: 20260612142910_qa_schema_inventory_rpc.sql
-- Created: 2026-06-12T21:29:10Z
-- Description: qa_schema_inventory() — schema 契约检查的生产清单接口
--
-- 背景（2026-06 按钮审计根源的根源）：仓库迁移与生产 schema 漂移
-- 反复造成全员 500（发帖/点赞/watchlist/设置页），且 42703/PGRST202
-- 常被 safeQuery 静默吞掉。scripts/qa/schema-contract-check.mjs 在
-- 运行时从代码提取 .rpc()/.from() 依赖，调用本函数取生产实际清单做
-- 差集 — 任何"代码在调但生产不存在"的对象立即暴露。
--
-- 安全：仅 service_role 可执行（schema 结构属敏感信息）。

-- Up
CREATE OR REPLACE FUNCTION qa_schema_inventory()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT jsonb_build_object(
    'functions', (
      SELECT coalesce(jsonb_agg(DISTINCT p.proname), '[]'::jsonb)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    ),
    'tables', (
      SELECT coalesce(jsonb_agg(DISTINCT t.table_name), '[]'::jsonb)
      FROM information_schema.tables t
      WHERE t.table_schema = 'public'
    ),
    'columns', (
      SELECT coalesce(
        jsonb_object_agg(tc.table_name, tc.cols), '{}'::jsonb
      )
      FROM (
        SELECT c.table_name, jsonb_agg(c.column_name) AS cols
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
        GROUP BY c.table_name
      ) tc
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION qa_schema_inventory() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION qa_schema_inventory() FROM anon;
REVOKE EXECUTE ON FUNCTION qa_schema_inventory() FROM authenticated;
GRANT EXECUTE ON FUNCTION qa_schema_inventory() TO service_role;
