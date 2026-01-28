/**
 * Setup Storage Policies via Supabase REST API
 * Run: node scripts/setup_storage_policies.mjs
 */

import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing environment variables')
  process.exit(1)
}

// Extract project ref from URL
const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]

if (!projectRef) {
  console.error('❌ Could not extract project ref from URL')
  process.exit(1)
}

console.log(`📋 Project: ${projectRef}`)

// SQL to execute
const sql = `
-- Enable RLS
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Avatars policies
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

-- Covers policies
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

SELECT 'Policies created successfully' as result;
`

async function executeSql() {
  console.log('🔧 Executing SQL via REST API...\n')

  try {
    // Try using the SQL endpoint (available in some Supabase versions)
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`
      },
      body: JSON.stringify({ query: sql })
    })

    if (response.ok) {
      console.log('✅ SQL executed successfully!')
      return
    }

    // If exec_sql doesn't exist, provide manual instructions
    console.log('⚠️  Cannot execute SQL directly via API.')
    console.log('')
    console.log('📋 Please run the following SQL manually in Supabase Dashboard:')
    console.log('   1. Go to: https://supabase.com/dashboard/project/' + projectRef + '/sql/new')
    console.log('   2. Paste and run the contents of: scripts/setup_avatar_storage.sql')
    console.log('')
    console.log('Or copy this SQL:')
    console.log('─'.repeat(60))
    console.log(sql)
    console.log('─'.repeat(60))

  } catch (error) {
    console.error('Error:', error.message)
    console.log('')
    console.log('📋 Please run SQL manually. Dashboard link:')
    console.log(`   https://supabase.com/dashboard/project/${projectRef}/sql/new`)
  }
}

executeSql()
