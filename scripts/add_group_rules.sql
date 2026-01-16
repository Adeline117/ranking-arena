-- 添加小组发言规则字段

-- 添加 rules 字段到 groups 表
ALTER TABLE groups ADD COLUMN IF NOT EXISTS rules TEXT;

-- 更新一些示例规则
UPDATE groups SET rules = '1. 请尊重他人，禁止人身攻击
2. 请勿发布广告或垃圾信息
3. 讨论内容需与小组主题相关
4. 禁止发布任何违法内容' WHERE rules IS NULL;

-- 验证
SELECT id, name, rules FROM groups LIMIT 5;


