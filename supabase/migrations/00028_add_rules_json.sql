-- Migration: Add rules_json column for bilingual group rules
-- This column stores rules in both Chinese and English

-- Add rules_json column to groups table
ALTER TABLE groups
ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN groups.rules_json IS 'Bilingual rules array: [{ "zh": "中文规则", "en": "English rule" }, ...]';

-- Add rules_json to group_applications table (for new group applications)
ALTER TABLE group_applications
ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;

-- Add rules_json to group_edit_applications table (for group edit requests)
ALTER TABLE group_edit_applications
ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;
