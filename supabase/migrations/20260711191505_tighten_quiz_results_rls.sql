-- Migration: 20260711191505_tighten_quiz_results_rls.sql
-- Created: 2026-07-11 (PT)
-- Description: 收紧 quiz_results 的匿名 INSERT 策略(上线安全审计 2026-07-11)。
--
-- 问题:策略 quiz_insert 为 cmd=INSERT roles={public} with_check=true —— 无任何
-- user_id 约束(Supabase advisor 报 rls_policy_always_true)。任何未登录者可
-- 直接 POST /rest/v1/quiz_results 批量灌垃圾行,或把 user_id 设成任意受害者
-- UUID 污染其测验记录/排行。
--
-- 核实:唯一合法写路径 app/api/quiz/save/route.ts:78 走 getSupabaseAdmin()
-- (service role,绕过 RLS),无任何客户端/anon 直插。故直接 DROP 这条纵容策略,
-- 合法写入照常,匿名 PostgREST 伪造插入被默认拒绝挡下。SELECT 策略
-- (quiz_select_own,仅本人)不动。

-- Up
DROP POLICY IF EXISTS quiz_insert ON public.quiz_results;

-- Rollback (reference only — forward-only migrations):
-- CREATE POLICY quiz_insert ON public.quiz_results FOR INSERT TO public WITH CHECK (true);
