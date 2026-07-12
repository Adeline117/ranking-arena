-- Migration: 20260711204608_revoke_anon_execute_sdf.sql
-- Created: 2026-07-11 (PT)
-- Description: 收回 6 个写型 SECURITY DEFINER 函数的 anon/PUBLIC EXECUTE(上线安全审计)。
--
-- 问题:Supabase advisor 报 anon_security_definer_function_executable —— 这些
-- 写副作用函数默认 GRANT EXECUTE TO PUBLIC(anon 是 PUBLIC 成员),匿名者可直接
-- rpc() 调用绕过 API 层的 dedup/鉴权门禁(CLAUDE.md 只在 route 层 grep 拦)。
--
-- 核实(Explore agent 逐个追调用点,file:line 见 LAUNCH_AUDIT_2026-07-11):
--  - create_{like,comment,message}_notification: 纯触发器函数,代码零 .rpc() 引用,
--    触发器以 definer 权限触发,与 EXECUTE 授权无关 → 收回不影响触发。
--  - increment_impression_count / toggle_post_reaction / record_rejected_writes:
--    唯一调用点均在 Next API route 走 service-role client → 执行角色 service_role。
--  零 'use client' 前端以 anon client 直调。故 REVOKE FROM PUBLIC 安全。
--
-- 注意:必须 REVOKE FROM PUBLIC(不是 FROM anon)—— anon 经 PUBLIC 继承,单收 anon
-- 无效(has_function_privilege 仍 true)。收后显式 GRANT 回 service_role 保合法调用。

-- Up
REVOKE EXECUTE ON FUNCTION public.create_like_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_comment_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_message_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_impression_count(post_id uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_rejected_writes(p_rows jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.toggle_post_reaction(p_post_id uuid, p_user_id uuid, p_reaction_type text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.increment_impression_count(post_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_rejected_writes(p_rows jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_reaction(p_post_id uuid, p_user_id uuid, p_reaction_type text) TO service_role;
