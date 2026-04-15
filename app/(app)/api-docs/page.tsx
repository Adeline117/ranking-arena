import type { Metadata } from 'next'
import { tokens } from '@/lib/design-tokens'

export const metadata: Metadata = {
  title: 'API Documentation',
  description: 'Arena public API for crypto trader rankings, trader details, and search. Free tier: 100 requests/day.',
}

const ENDPOINTS = [
  {
    name: 'Rankings',
    method: 'GET',
    path: '/api/v3?endpoint=rankings',
    description: 'Get ranked traders from the leaderboard, optionally filtered by platform and period.',
    params: [
      { name: 'platform', type: 'string', required: false, description: 'Exchange platform key (e.g. binance_futures, bybit, hyperliquid)' },
      { name: 'period', type: 'string', required: false, description: 'Trading period: 7D, 30D, or 90D (default: 90D)' },
      { name: 'limit', type: 'number', required: false, description: 'Number of results (1-200, default: 50)' },
      { name: 'offset', type: 'number', required: false, description: 'Pagination offset (default: 0)' },
    ],
    example: {
      request: 'GET /api/v3?endpoint=rankings&platform=binance_futures&period=90D&limit=10',
      response: `{
  "data": [
    {
      "traderKey": "abc123",
      "handle": "TopTrader",
      "platform": "binance_futures",
      "roi": 245.5,
      "pnl": 89000,
      "arenaScore": 87.3,
      "rank": 1,
      "winRate": 68.5,
      "maxDrawdown": -12.3
    }
  ],
  "meta": {
    "total": 500,
    "endpoint": "rankings",
    "version": "v3",
    "credits_remaining": 99,
    "rate_limit": { "daily_limit": 100, "remaining": 99 }
  }
}`,
    },
  },
  {
    name: 'Trader Detail',
    method: 'GET',
    path: '/api/v3?endpoint=trader',
    description: 'Get full details for a specific trader including performance across periods, equity curve, and positions.',
    params: [
      { name: 'platform', type: 'string', required: true, description: 'Exchange platform key' },
      { name: 'trader_key', type: 'string', required: true, description: 'Trader unique identifier on the platform' },
    ],
    example: {
      request: 'GET /api/v3?endpoint=trader&platform=binance_futures&trader_key=abc123',
      response: `{
  "data": {
    "profile": { "handle": "TopTrader", "platform": "binance_futures", "avatarUrl": "..." },
    "performance": { "roi_90d": 245.5, "pnl": 89000, "arena_score": 87.3, "rank": 1 },
    "equityCurve": { "90D": [{ "date": "2026-01-01", "roi": 10.5, "pnl": 1050 }] }
  },
  "meta": { "endpoint": "trader", "version": "v3" }
}`,
    },
  },
  {
    name: 'Search',
    method: 'GET',
    path: '/api/v3?endpoint=search',
    description: 'Search for traders by name or handle. Supports fuzzy matching.',
    params: [
      { name: 'q', type: 'string', required: true, description: 'Search query (min 2 characters)' },
      { name: 'limit', type: 'number', required: false, description: 'Number of results (1-100, default: 20)' },
      { name: 'platform', type: 'string', required: false, description: 'Filter by platform' },
    ],
    example: {
      request: 'GET /api/v3?endpoint=search&q=whale&limit=5',
      response: `{
  "data": [
    {
      "traderKey": "whale_master",
      "handle": "WhaleMaster",
      "platform": "bybit",
      "roi": 180.2,
      "arenaScore": 82.1
    }
  ],
  "meta": { "total": 12, "endpoint": "search", "version": "v3" }
}`,
    },
  },
]

export default function ApiDocsPage() {
  return (
    <div style={{
      maxWidth: 900,
      margin: '0 auto',
      padding: `${tokens.spacing[8]} ${tokens.spacing[5]}`,
      color: 'var(--color-text-primary)',
      fontFamily: tokens.typography.fontFamily.sans.join(', '),
    }}>
      <h1 style={{ fontSize: tokens.typography.fontSize['3xl'], fontWeight: 800, marginBottom: tokens.spacing[2] }}>
        Arena API
      </h1>
      <p style={{ fontSize: tokens.typography.fontSize.md, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[8], lineHeight: 1.6 }}>
        Access crypto trader rankings, performance data, and search across 28+ exchanges and 34,000+ traders.
      </p>

      {/* Rate Limit Info */}
      <div style={{
        padding: tokens.spacing[5],
        borderRadius: tokens.radius.lg,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-primary)',
        marginBottom: tokens.spacing[8],
      }}>
        <h2 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: 700, marginBottom: tokens.spacing[3] }}>
          Rate Limits
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacing[4] }}>
          <div>
            <div style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, marginBottom: tokens.spacing[1] }}>
              Free Tier
            </div>
            <div style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-secondary)' }}>
              100 requests/day per IP. No authentication required.
            </div>
          </div>
          <div>
            <div style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, marginBottom: tokens.spacing[1] }}>
              API Key
            </div>
            <div style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-secondary)' }}>
              Unlimited requests. Pass <code style={{ padding: '2px 6px', borderRadius: 4, background: 'var(--color-bg-tertiary)', fontSize: 11 }}>X-API-Key</code> header.
            </div>
          </div>
        </div>
      </div>

      {/* Authentication */}
      <div style={{
        padding: tokens.spacing[5],
        borderRadius: tokens.radius.lg,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-primary)',
        marginBottom: tokens.spacing[8],
      }}>
        <h2 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: 700, marginBottom: tokens.spacing[3] }}>
          Authentication
        </h2>
        <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3], lineHeight: 1.6 }}>
          For authenticated access, include your API key in the request header:
        </p>
        <pre style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.md,
          background: 'var(--color-bg-tertiary)',
          fontSize: 13,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
          overflow: 'auto',
          lineHeight: 1.6,
        }}>
{`curl -H "X-API-Key: your_api_key" \\
  "https://www.arenafi.org/api/v3?endpoint=rankings&limit=10"`}
        </pre>
      </div>

      {/* Endpoints */}
      <h2 style={{ fontSize: tokens.typography.fontSize.xl, fontWeight: 700, marginBottom: tokens.spacing[5] }}>
        Endpoints
      </h2>

      {ENDPOINTS.map((ep) => (
        <div key={ep.name} style={{
          marginBottom: tokens.spacing[8],
          padding: tokens.spacing[5],
          borderRadius: tokens.radius.lg,
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-primary)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[3] }}>
            <span style={{
              padding: '2px 10px',
              borderRadius: tokens.radius.sm,
              background: 'rgba(47, 229, 125, 0.15)',
              color: 'var(--color-accent-success)',
              fontSize: 12,
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}>
              {ep.method}
            </span>
            <code style={{ fontSize: 14, fontWeight: 600, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
              {ep.path}
            </code>
          </div>
          <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[4], lineHeight: 1.6 }}>
            {ep.description}
          </p>

          {/* Parameters */}
          <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: tokens.spacing[2], color: 'var(--color-text-secondary)' }}>
            Parameters
          </h4>
          <div style={{
            borderRadius: tokens.radius.md,
            border: '1px solid var(--color-border-primary)',
            overflow: 'hidden',
            marginBottom: tokens.spacing[4],
          }}>
            {ep.params.map((p, i) => (
              <div key={p.name} style={{
                display: 'grid',
                gridTemplateColumns: '120px 70px 1fr',
                gap: tokens.spacing[3],
                padding: '8px 12px',
                fontSize: 13,
                borderBottom: i < ep.params.length - 1 ? '1px solid var(--color-border-primary)' : undefined,
                background: i % 2 === 0 ? 'var(--color-bg-tertiary)' : 'transparent',
              }}>
                <code style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), fontWeight: 600 }}>{p.name}</code>
                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 12 }}>
                  {p.required ? 'required' : 'optional'}
                </span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{p.description}</span>
              </div>
            ))}
          </div>

          {/* Example */}
          <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: tokens.spacing[2], color: 'var(--color-text-secondary)' }}>
            Example
          </h4>
          <pre style={{
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: 'var(--color-bg-tertiary)',
            fontSize: 12,
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
            overflow: 'auto',
            marginBottom: tokens.spacing[2],
            lineHeight: 1.5,
            color: 'var(--color-accent-success)',
          }}>
            {ep.example.request}
          </pre>
          <pre style={{
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: 'var(--color-bg-tertiary)',
            fontSize: 11,
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
            overflow: 'auto',
            lineHeight: 1.5,
            maxHeight: 300,
          }}>
            {ep.example.response}
          </pre>
        </div>
      ))}

      {/* Footer */}
      <div style={{
        padding: tokens.spacing[5],
        borderRadius: tokens.radius.lg,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-primary)',
        textAlign: 'center',
      }}>
        <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[2] }}>
          Need an API key for unlimited access?
        </p>
        <a
          href="/settings"
          style={{
            display: 'inline-block',
            padding: '8px 24px',
            borderRadius: tokens.radius.md,
            background: 'var(--color-brand)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Get API Key
        </a>
      </div>
    </div>
  )
}
