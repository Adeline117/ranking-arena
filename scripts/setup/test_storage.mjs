/**
 * Test storage bucket access
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
})

async function test() {
  console.log('Testing storage access...\n')

  // List buckets
  const { data: buckets, error: listError } = await supabase.storage.listBuckets()

  if (listError) {
    console.error('❌ Failed to list buckets:', listError.message)
    return
  }

  console.log('📦 Available buckets:')
  buckets.forEach(b => {
    console.log(`   - ${b.id} (public: ${b.public})`)
  })

  // Test upload to avatars
  console.log('\n🧪 Testing upload to avatars bucket...')
  // Minimal valid 1x1 PNG
  const pngData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload('test-file.png', pngData, { upsert: true, contentType: 'image/png' })

  if (uploadError) {
    console.log('❌ Upload failed:', uploadError.message)
  } else {
    console.log('✅ Upload successful!')

    // Clean up
    await supabase.storage.from('avatars').remove(['test-file.png'])
    console.log('🧹 Cleaned up test file')
  }

  // Test upload to covers
  console.log('\n🧪 Testing upload to covers bucket...')
  const { error: coverError } = await supabase.storage
    .from('covers')
    .upload('test-file.png', pngData, { upsert: true, contentType: 'image/png' })

  if (coverError) {
    console.log('❌ Upload failed:', coverError.message)
  } else {
    console.log('✅ Upload successful!')

    // Clean up
    await supabase.storage.from('covers').remove(['test-file.png'])
    console.log('🧹 Cleaned up test file')
  }

  console.log('\n✅ Storage test complete!')
}

test().catch(console.error)
