// lib/supabase/client.ts
// Uses top-level await + dynamic import to code-split @supabase/supabase-js (~170KB)
// into a separate chunk that loads asynchronously.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

const { createClient } = await import("@supabase/supabase-js");

export const supabase = createClient(url, anon, {
  auth: {
    persistSession: true,
    storageKey: 'arena-auth',
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
