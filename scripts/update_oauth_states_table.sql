-- 更新 OAuth states 表，添加 PKCE 支持
-- 执行此脚本前，请确保已创建基础的 oauth_states 表

-- 添加 code_verifier 列（用于 PKCE 流程）
ALTER TABLE oauth_states 
ADD COLUMN IF NOT EXISTS code_verifier TEXT;

-- 添加注释
COMMENT ON COLUMN oauth_states.code_verifier IS 'PKCE code_verifier，用于 PKCE 授权流程';

-- 查看更新后的表结构
-- \d oauth_states

