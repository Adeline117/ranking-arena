#!/bin/bash
# RLS 迁移验证脚本
# 用于验证 00011_fix_rls_security.sql 是否正确应用

set -e

echo "=========================================="
echo "RLS 迁移验证脚本"
echo "=========================================="
echo ""

# 检查必要的环境变量
if [ -z "$SUPABASE_DB_URL" ]; then
  echo "❌ 错误: 请设置 SUPABASE_DB_URL 环境变量"
  echo "   示例: export SUPABASE_DB_URL='postgresql://postgres:password@localhost:54322/postgres'"
  exit 1
fi

echo "✅ 数据库连接: ${SUPABASE_DB_URL:0:30}..."
echo ""

# 1. 验证辅助函数存在
echo "=== 1. 验证辅助函数 ==="
psql "$SUPABASE_DB_URL" -t -c "
  SELECT
    proname as function_name,
    pg_get_function_result(oid) as return_type
  FROM pg_proc
  WHERE proname IN ('is_group_admin', 'is_site_admin', 'is_premium_user')
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
" | while read line; do
  if [ -n "$line" ]; then
    echo "  ✅ $line"
  fi
done

# 2. 验证索引存在
echo ""
echo "=== 2. 验证索引 ==="
psql "$SUPABASE_DB_URL" -t -c "
  SELECT indexname
  FROM pg_indexes
  WHERE indexname IN (
    'idx_group_members_user_role',
    'idx_user_profiles_role_admin',
    'idx_subscriptions_active_premium'
  );
" | while read line; do
  if [ -n "$line" ]; then
    echo "  ✅ 索引存在: $line"
  fi
done

# 3. 验证 RLS 策略
echo ""
echo "=== 3. 验证 RLS 策略 ==="

# notifications
echo ""
echo "  【notifications】"
psql "$SUPABASE_DB_URL" -t -c "
  SELECT policyname
  FROM pg_policies
  WHERE tablename = 'notifications'
    AND policyname = 'Only service role can insert notifications';
" | grep -q "Only service role" && echo "    ✅ INSERT 策略已更新" || echo "    ❌ INSERT 策略未找到"

# risk_alerts
echo ""
echo "  【risk_alerts】"
psql "$SUPABASE_DB_URL" -t -c "
  SELECT policyname
  FROM pg_policies
  WHERE tablename = 'risk_alerts'
    AND policyname = 'Only service role can insert risk alerts';
" | grep -q "Only service role" && echo "    ✅ INSERT 策略已更新" || echo "    ❌ INSERT 策略未找到"

# group_applications
echo ""
echo "  【group_applications】"
psql "$SUPABASE_DB_URL" -t -c "
  SELECT policyname
  FROM pg_policies
  WHERE tablename = 'group_applications'
    AND policyname LIKE 'Group admins%';
" | grep -q "Group admins" && echo "    ✅ 群组管理员策略已添加" || echo "    ❌ 群组管理员策略未找到"

# posts DELETE
echo ""
echo "  【posts】"
psql "$SUPABASE_DB_URL" -t -c "
  SELECT policyname
  FROM pg_policies
  WHERE tablename = 'posts'
    AND policyname = 'Authors and group admins can delete posts';
" | grep -q "Authors and group admins" && echo "    ✅ DELETE 策略已更新" || echo "    ❌ DELETE 策略未找到"

# comments DELETE
echo ""
echo "  【comments】"
psql "$SUPABASE_DB_URL" -t -c "
  SELECT policyname
  FROM pg_policies
  WHERE tablename = 'comments'
    AND policyname = 'Authors and group admins can delete comments';
" | grep -q "Authors and group admins" && echo "    ✅ DELETE 策略已更新" || echo "    ❌ DELETE 策略未找到"

echo ""
echo "=========================================="
echo "验证完成"
echo "=========================================="
