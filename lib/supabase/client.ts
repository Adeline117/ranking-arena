// lib/supabase/client.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// #region agent log
if (typeof window !== 'undefined') {
  const storageKeys = Object.keys(localStorage).filter(k => k.includes('supabase') || k.includes('sb-') || k.includes('arena-auth'));
  fetch('http://127.0.0.1:7242/ingest/b63de3a5-4496-4429-a509-5e2629219497',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'supabase/client.ts:init',message:'Supabase client init - localStorage check',data:{storageKeys,hasUrl:!!url,hasAnon:!!anon},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
}
// #endregion

export const supabase = createClient(url, anon, {
  auth: {
    persistSession: true,
    storageKey: 'arena-auth',
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
