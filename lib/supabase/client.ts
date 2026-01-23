// lib/supabase/client.ts
import { createClient } from "@supabase/supabase-js";

// 构建时使用占位符，运行时使用真实环境变量
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const supabase = createClient(url, anon, {
  auth: {
    persistSession: true,
    storageKey: 'arena-auth',
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
