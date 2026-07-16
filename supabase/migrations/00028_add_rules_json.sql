-- Migration: Add rules_json column for bilingual group rules
-- This column stores rules in both Chinese and English

-- Keep the canonical migration chain self-contained. This relation is first
-- altered in this migration, so fresh databases must establish its complete
-- baseline contract here instead of relying on an out-of-band bootstrap.
CREATE TABLE IF NOT EXISTS public.group_edit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  applicant_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  name_en text,
  description text,
  description_en text,
  avatar_url text,
  rules_json jsonb DEFAULT NULL,
  rules text,
  role_names jsonb,
  is_premium_only boolean,
  status text NOT NULL DEFAULT 'pending',
  reject_reason text,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.group_edit_applications ENABLE ROW LEVEL SECURITY;

-- Add rules_json column to groups table
ALTER TABLE groups
ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN groups.rules_json IS 'Bilingual rules array: [{ "zh": "中文规则", "en": "English rule" }, ...]';

-- Add rules_json to group_applications table (for new group applications)
ALTER TABLE group_applications
ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;

-- Add rules_json to group_edit_applications table (for group edit requests)
ALTER TABLE public.group_edit_applications
ADD COLUMN IF NOT EXISTS rules_json jsonb DEFAULT NULL;
