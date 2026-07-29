/**
 * Retired legacy portfolio-snapshot writer.
 *
 * The former job derived `total_equity` from `size * mark_price`. That is a
 * position's notional exposure, not account equity: it ignores cash balances,
 * margin and the sign/semantics of short positions. Publishing that value into
 * the user's net-worth history corrupts financial data.
 *
 * `/api/portfolio/sync` now owns snapshot publication. It passes the exact
 * exchange-reported account equity into `publish_portfolio_sync_atomic` in the
 * same transaction that publishes the corresponding positions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      replacement: '/api/portfolio/sync atomic exchange-equity publication',
    },
    { status: 410 }
  )
}
