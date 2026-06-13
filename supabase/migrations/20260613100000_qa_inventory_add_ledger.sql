-- Migration: 20260613100000_qa_inventory_add_ledger.sql
-- Description: qa_schema_inventory() 增加 migration_names 数组（已应用迁移的名字）
--   服务于 P1 迁移落地核对(check-migration-ledger.mjs):
--   仓库里 baseline 之后的迁移文件,其名字(去时间戳前缀)必须出现在生产
--   ledger 的 name 集合,否则 = 未应用漂移。
--   按 name 匹配(非 version):MCP/SQL-editor 应用会重写 version 时间戳,
--   但 name 保持 = 仓库文件描述部分,所以 name 匹配稳健。
--   向后兼容:schema-contract-check 只读 functions/tables/columns,忽略新键。

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
    ),
    'migration_names', (
      SELECT coalesce(jsonb_agg(DISTINCT name), '[]'::jsonb)
      FROM supabase_migrations.schema_migrations
      WHERE name IS NOT NULL AND name <> ''
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION qa_schema_inventory() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION qa_schema_inventory() FROM anon;
REVOKE EXECUTE ON FUNCTION qa_schema_inventory() FROM authenticated;
GRANT EXECUTE ON FUNCTION qa_schema_inventory() TO service_role;
