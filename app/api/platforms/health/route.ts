/**
 * GET /api/platforms/health
 *
 * Returns health status for all platforms.
 * Used by frontend to show which platforms are available.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function GET() {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: health } = await supabase
      .from('platform_health')
      .select('*')
      .order('platform');

    // Also get latest snapshot timestamps per platform
    const { data: freshness } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, market_type, as_of_ts')
      .order('as_of_ts', { ascending: false })
      .limit(50);

    // Aggregate freshness by platform
    const latestByPlatform = new Map<string, string>();
    for (const row of freshness || []) {
      const key = `${row.platform}:${row.market_type}`;
      if (!latestByPlatform.has(key)) {
        latestByPlatform.set(key, row.as_of_ts);
      }
    }

    return NextResponse.json({
      platforms: health || [],
      freshness: Object.fromEntries(latestByPlatform),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('[platforms/health] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
