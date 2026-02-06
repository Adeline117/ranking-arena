-- Add images array to content_reports for screenshot evidence
ALTER TABLE content_reports ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Also expand content_type constraint to support 'user' and 'message'
ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_content_type_check;
ALTER TABLE content_reports ADD CONSTRAINT content_reports_content_type_check 
  CHECK (content_type IN ('post', 'comment', 'message', 'user'));

-- Expand reason constraint to include 'fraud'
ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_reason_check;
ALTER TABLE content_reports ADD CONSTRAINT content_reports_reason_check 
  CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other'));
