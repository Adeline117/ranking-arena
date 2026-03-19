// lib/supabase/client.ts
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

// Singleton — created once on first access to avoid multiple GoTrue instances.
// The module is eagerly imported by Next.js so we keep createClient() cheap:
// it is synchronous and sets up the client in-memory; network requests only
// happen when methods like .auth.getUser() or .from().select() are called.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const supabase: SupabaseClient = createClient(url, anon, {
  auth: {
    persistSession: true,
    storageKey: 'arena-auth',
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
