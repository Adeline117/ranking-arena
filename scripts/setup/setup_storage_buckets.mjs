/**
 * Setup Storage Buckets for Avatars and Covers
 * Run: node scripts/setup_storage_buckets.mjs
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
})

async function setupBuckets() {
  console.log('🚀 Setting up storage buckets...\n')

  // Define buckets to create
  const buckets = [
    {
      id: 'avatars',
      name: 'avatars',
      public: true,
      fileSizeLimit: 5 * 1024 * 1024, // 5MB
      allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    },
    {
      id: 'covers',
      name: 'covers',
      public: true,
      fileSizeLimit: 10 * 1024 * 1024, // 10MB
      allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    }
  ]

  // List existing buckets
  const { data: existingBuckets, error: listError } = await supabase.storage.listBuckets()

  if (listError) {
    console.error('❌ Failed to list buckets:', listError.message)
    process.exit(1)
  }

  console.log('📦 Existing buckets:', existingBuckets?.map(b => b.id).join(', ') || 'none')
  console.log('')

  for (const bucket of buckets) {
    const exists = existingBuckets?.some(b => b.id === bucket.id)

    if (exists) {
      console.log(`✅ Bucket "${bucket.id}" already exists, updating...`)

      const { error: updateError } = await supabase.storage.updateBucket(bucket.id, {
        public: bucket.public,
        fileSizeLimit: bucket.fileSizeLimit,
        allowedMimeTypes: bucket.allowedMimeTypes
      })

      if (updateError) {
        console.error(`   ❌ Failed to update: ${updateError.message}`)
      } else {
        console.log(`   ✅ Updated successfully`)
      }
    } else {
      console.log(`📁 Creating bucket "${bucket.id}"...`)

      const { error: createError } = await supabase.storage.createBucket(bucket.id, {
        public: bucket.public,
        fileSizeLimit: bucket.fileSizeLimit,
        allowedMimeTypes: bucket.allowedMimeTypes
      })

      if (createError) {
        console.error(`   ❌ Failed to create: ${createError.message}`)
      } else {
        console.log(`   ✅ Created successfully`)
      }
    }
  }

  console.log('\n✅ Storage bucket setup complete!')
  console.log('')
  console.log('⚠️  Note: RLS policies need to be set via SQL.')
  console.log('   Run the following SQL in Supabase Dashboard > SQL Editor:')
  console.log('')
  console.log('   -- Enable public read for avatars')
  console.log('   DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;')
  console.log('   CREATE POLICY "avatars_public_read" ON storage.objects')
  console.log('   FOR SELECT USING (bucket_id = \'avatars\');')
  console.log('')
  console.log('   -- Enable authenticated users to upload avatars')
  console.log('   DROP POLICY IF EXISTS "avatars_auth_insert" ON storage.objects;')
  console.log('   CREATE POLICY "avatars_auth_insert" ON storage.objects')
  console.log('   FOR INSERT WITH CHECK (')
  console.log('     bucket_id = \'avatars\'')
  console.log('     AND auth.role() = \'authenticated\'')
  console.log('     AND name LIKE auth.uid()::text || \'-%\'')
  console.log('   );')
  console.log('')
  console.log('   (See scripts/setup_avatar_storage.sql for full policies)')
}

setupBuckets().catch(console.error)
