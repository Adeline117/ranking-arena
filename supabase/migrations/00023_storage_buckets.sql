-- =============================================
-- Storage Buckets for User Avatars and Covers
-- =============================================

-- Create avatars bucket (public, for user profile pictures)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  5242880, -- 5MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Create covers bucket (public, for user profile covers)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'covers',
  'covers',
  true,
  10485760, -- 10MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- =============================================
-- RLS Policies for avatars bucket
-- =============================================

-- Allow public read access to avatars
DROP POLICY IF EXISTS "Public can view avatars" ON storage.objects;
CREATE POLICY "Public can view avatars"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

-- Allow authenticated users to upload their own avatar
DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;
CREATE POLICY "Users can upload own avatar"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'avatars'
  AND auth.role() = 'authenticated'
  AND (storage.foldername(name))[1] = auth.uid()::text
  OR (
    bucket_id = 'avatars'
    AND auth.role() = 'authenticated'
    AND name LIKE auth.uid()::text || '-%'
  )
);

-- Allow users to update their own avatar
DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'avatars'
  AND auth.role() = 'authenticated'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR name LIKE auth.uid()::text || '-%'
  )
);

-- Allow users to delete their own avatar
DROP POLICY IF EXISTS "Users can delete own avatar" ON storage.objects;
CREATE POLICY "Users can delete own avatar"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'avatars'
  AND auth.role() = 'authenticated'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR name LIKE auth.uid()::text || '-%'
  )
);

-- =============================================
-- RLS Policies for covers bucket
-- =============================================

-- Allow public read access to covers
DROP POLICY IF EXISTS "Public can view covers" ON storage.objects;
CREATE POLICY "Public can view covers"
ON storage.objects FOR SELECT
USING (bucket_id = 'covers');

-- Allow authenticated users to upload their own cover
DROP POLICY IF EXISTS "Users can upload own cover" ON storage.objects;
CREATE POLICY "Users can upload own cover"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'covers'
  AND auth.role() = 'authenticated'
  AND (storage.foldername(name))[1] = auth.uid()::text
  OR (
    bucket_id = 'covers'
    AND auth.role() = 'authenticated'
    AND name LIKE auth.uid()::text || '-%'
  )
);

-- Allow users to update their own cover
DROP POLICY IF EXISTS "Users can update own cover" ON storage.objects;
CREATE POLICY "Users can update own cover"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'covers'
  AND auth.role() = 'authenticated'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR name LIKE auth.uid()::text || '-%'
  )
);

-- Allow users to delete their own cover
DROP POLICY IF EXISTS "Users can delete own cover" ON storage.objects;
CREATE POLICY "Users can delete own cover"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'covers'
  AND auth.role() = 'authenticated'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR name LIKE auth.uid()::text || '-%'
  )
);
