/**
 * Create Storage Policies via Supabase Storage API
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const policies = [
  // Avatars policies
  {
    name: 'avatars_public_read',
    bucket_id: 'avatars',
    operation: 'SELECT',
    definition: 'true',
    check: null
  },
  {
    name: 'avatars_auth_insert',
    bucket_id: 'avatars',
    operation: 'INSERT',
    definition: null,
    check: "(auth.role() = 'authenticated' AND name LIKE (auth.uid()::text || '-%'))"
  },
  {
    name: 'avatars_auth_update',
    bucket_id: 'avatars',
    operation: 'UPDATE',
    definition: "(auth.role() = 'authenticated' AND name LIKE (auth.uid()::text || '-%'))",
    check: null
  },
  {
    name: 'avatars_auth_delete',
    bucket_id: 'avatars',
    operation: 'DELETE',
    definition: "(auth.role() = 'authenticated' AND name LIKE (auth.uid()::text || '-%'))",
    check: null
  },
  // Covers policies
  {
    name: 'covers_public_read',
    bucket_id: 'covers',
    operation: 'SELECT',
    definition: 'true',
    check: null
  },
  {
    name: 'covers_auth_insert',
    bucket_id: 'covers',
    operation: 'INSERT',
    definition: null,
    check: "(auth.role() = 'authenticated' AND name LIKE (auth.uid()::text || '-%'))"
  },
  {
    name: 'covers_auth_update',
    bucket_id: 'covers',
    operation: 'UPDATE',
    definition: "(auth.role() = 'authenticated' AND name LIKE (auth.uid()::text || '-%'))",
    check: null
  },
  {
    name: 'covers_auth_delete',
    bucket_id: 'covers',
    operation: 'DELETE',
    definition: "(auth.role() = 'authenticated' AND name LIKE (auth.uid()::text || '-%'))",
    check: null
  }
]

async function createPolicies() {
  console.log('🔧 Creating storage policies...\n')

  for (const policy of policies) {
    console.log(`Creating policy: ${policy.name}...`)

    try {
      // Try the storage API endpoint
      const res = await fetch(`${supabaseUrl}/storage/v1/policies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'apikey': supabaseServiceKey
        },
        body: JSON.stringify(policy)
      })

      if (res.ok) {
        console.log(`  ✅ Created`)
      } else {
        const text = await res.text()
        if (text.includes('already exists') || text.includes('duplicate')) {
          console.log(`  ⏭️  Already exists`)
        } else {
          console.log(`  ❌ Failed: ${res.status} - ${text}`)
        }
      }
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`)
    }
  }

  console.log('\n✅ Done!')
}

createPolicies()
