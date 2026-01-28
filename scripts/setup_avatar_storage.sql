-- =============================================
-- Quick Setup Script for Avatar & Cover Storage
-- Run this in Supabase Dashboard > SQL Editor
-- =============================================

-- 1. Create avatars bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 2. Create covers bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'covers',
  'covers',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- 3. Enable RLS on storage.objects (if not already enabled)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 4. Policies for avatars (drop first to avoid conflicts)
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
DROP POLICY IF EXISTS "avatars_auth_insert" ON storage.objects;
DROP POLICY IF EXISTS "avatars_auth_update" ON storage.objects;
DROP POLICY IF EXISTS "avatars_auth_delete" ON storage.objects;

CREATE POLICY "avatars_public_read" ON storage.objects
FOR SELECT USING (bucket_id = 'avatars');

CREATE POLICY "avatars_auth_insert" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'avatars'
  AND auth.role() = 'authenticated'
  AND name LIKE auth.uid()::text || '-%'
);

CREATE POLICY "avatars_auth_update" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'avatars'
  AND auth.role() = 'authenticated'
  AND name LIKE auth.uid()::text || '-%'
);

CREATE POLICY "avatars_auth_delete" ON storage.objects
FOR DELETE USING (
  bucket_id = 'avatars'
  AND auth.role() = 'authenticated'
  AND name LIKE auth.uid()::text || '-%'
);

-- 5. Policies for covers (drop first to avoid conflicts)
DROP POLICY IF EXISTS "covers_public_read" ON storage.objects;
DROP POLICY IF EXISTS "covers_auth_insert" ON storage.objects;
DROP POLICY IF EXISTS "covers_auth_update" ON storage.objects;
DROP POLICY IF EXISTS "covers_auth_delete" ON storage.objects;

CREATE POLICY "covers_public_read" ON storage.objects
FOR SELECT USING (bucket_id = 'covers');

CREATE POLICY "covers_auth_insert" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'covers'
  AND auth.role() = 'authenticated'
  AND name LIKE auth.uid()::text || '-%'
);

CREATE POLICY "covers_auth_update" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'covers'
  AND auth.role() = 'authenticated'
  AND name LIKE auth.uid()::text || '-%'
);

CREATE POLICY "covers_auth_delete" ON storage.objects
FOR DELETE USING (
  bucket_id = 'covers'
  AND auth.role() = 'authenticated'
  AND name LIKE auth.uid()::text || '-%'
);

-- Verify buckets were created
SELECT id, name, public, file_size_limit FROM storage.buckets
WHERE id IN ('avatars', 'covers');
