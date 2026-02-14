/**
 * Create Supabase Storage buckets for media uploads.
 *
 * Run once:
 *   npx tsx scripts/setup/create-storage-buckets.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !key) {
  console.error('Missing SUPABASE env vars');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const BUCKETS = [
  { id: 'avatars', public: true },
  { id: 'posts', public: true },
  { id: 'library', public: true },
];

async function main() {
  for (const b of BUCKETS) {
    const { error } = await supabase.storage.createBucket(b.id, {
      public: b.public,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      fileSizeLimit: 5 * 1024 * 1024,
    });

    if (error) {
      if (error.message?.includes('already exists')) {
        console.log(`Bucket "${b.id}" already exists -- skipping`);
      } else {
        console.error(`Failed to create "${b.id}":`, error.message);
      }
    } else {
      console.log(`Created bucket "${b.id}" (public: ${b.public})`);
    }
  }
}

main();
