import type { Metadata } from 'next'
import { tokens, alpha } from '@/lib/design-tokens'
import { ApiPricingSection } from './ApiPricingSection'
import { getServerTranslation } from '@/lib/i18n/server'
import { getHeroStats } from '@/lib/data/hero-stats'
import { buildProductFactsSnapshot } from '@/lib/config/product-facts'

// Stable, XSS-safe anchor id for an endpoint name.
function epId(name: string): string {
  return (
    'endpoint-' +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

export const metadata: Metadata = {
  title: 'API Documentation — Arena Data API',
  description:
    'Access cross-exchange crypto trader rankings, performance data, and search. Free tier: 100 requests/day.',
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  {
    name: 'Rankings',
    method: 'GET',
    path: '/api/v3?endpoint=rankings',
    description:
      'Get ranked traders from the leaderboard, optionally filtered by platform and period.',
    params: [
      {
        name: 'platform',
        required: false,
        description: 'Exchange key (e.g. binance_futures, bybit, hyperliquid)',
      },
      { name: 'period', required: false, description: '7D, 30D, or 90D (default: 90D)' },
      { name: 'limit', required: false, description: '1-200 (default: 50)' },
      { name: 'offset', required: false, description: 'Pagination offset (default: 0)' },
    ],
    example: {
      curl: `curl "https://www.arenafi.org/api/v3?endpoint=rankings&platform=binance_futures&period=90D&limit=3"`,
      response: `{
  "success": true,
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
    "rate_limit": { "daily_limit": 100, "remaining": 99 }
  }
}`,
    },
  },
  {
    name: 'Trader Detail',
    method: 'GET',
    path: '/api/v3?endpoint=trader',
    description:
      'Get full details for a specific trader including performance across periods, equity curve, and positions.',
    params: [
      { name: 'platform', required: true, description: 'Exchange platform key' },
      { name: 'trader_key', required: true, description: 'Trader identifier on the platform' },
    ],
    example: {
      curl: `curl "https://www.arenafi.org/api/v3?endpoint=trader&platform=binance_futures&trader_key=abc123"`,
      response: `{
  "success": true,
  "data": {
    "profile": {
      "handle": "TopTrader",
      "platform": "binance_futures",
      "avatarUrl": "..."
    },
    "performance": {
      "roi_90d": 245.5,
      "pnl": 89000,
      "arena_score": 87.3,
      "rank": 1
    },
    "equityCurve": {
      "90D": [{ "date": "2026-01-01", "roi": 10.5, "pnl": 1050 }]
    }
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
      { name: 'q', required: true, description: 'Search query (min 2 characters)' },
      { name: 'limit', required: false, description: '1-100 (default: 20)' },
      { name: 'platform', required: false, description: 'Filter by platform' },
    ],
    example: {
      curl: `curl "https://www.arenafi.org/api/v3?endpoint=search&q=whale&limit=5"`,
      response: `{
  "success": true,
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
  {
    name: 'Platforms',
    method: 'GET',
    path: '/api/v3?endpoint=platforms',
    description: 'List all active exchanges with metadata including trader count.',
    params: [],
    example: {
      curl: `curl "https://www.arenafi.org/api/v3?endpoint=platforms"`,
      response: `{
  "success": true,
  "data": [
    {
      "key": "binance_futures",
      "name": "Binance",
      "type": "futures",
      "traderCount": 4200
    },
    {
      "key": "hyperliquid",
      "name": "Hyperliquid",
      "type": "web3",
      "traderCount": 3100
    }
  ],
  "meta": { "total": 28, "endpoint": "platforms", "version": "v3" }
}`,
    },
  },
  {
    name: 'History',
    method: 'GET',
    path: '/api/v3?endpoint=history',
    description:
      'Get daily performance time series for a specific trader. Returns ROI, PnL, win rate, and more.',
    params: [
      { name: 'platform', required: true, description: 'Exchange platform key' },
      { name: 'trader_key', required: true, description: 'Trader identifier on the platform' },
      { name: 'days', required: false, description: '1-90 (default: 30)' },
    ],
    example: {
      curl: `curl "https://www.arenafi.org/api/v3?endpoint=history&platform=binance_futures&trader_key=abc123&days=7"`,
      response: `{
  "success": true,
  "data": [
    {
      "date": "2026-05-05",
      "roi": 12.5,
      "pnl": 1250,
      "daily_return_pct": 1.2,
      "win_rate": 72.0,
      "max_drawdown": -5.3,
      "followers": 840,
      "trades_count": 15
    }
  ],
  "meta": { "total": 7, "endpoint": "history", "version": "v3" }
}`,
    },
  },
  {
    name: 'Bulk',
    method: 'GET',
    path: '/api/v3?endpoint=bulk',
    description:
      'Export top traders across all platforms in a single call. Useful for batch analysis.',
    params: [
      { name: 'period', required: false, description: '7D, 30D, or 90D (default: 90D)' },
      { name: 'limit', required: false, description: '1-500 (default: 100)' },
    ],
    example: {
      curl: `curl -H "X-API-Key: your_api_key" \\
  "https://www.arenafi.org/api/v3?endpoint=bulk&period=90D&limit=200"`,
      response: `{
  "success": true,
  "data": [
    {
      "traderKey": "abc123",
      "handle": "TopTrader",
      "platform": "binance_futures",
      "roi": 245.5,
      "pnl": 89000,
      "arenaScore": 87.3,
      "rank": 1
    }
  ],
  "meta": { "total": 8493, "endpoint": "bulk", "version": "v3" }
}`,
    },
  },
]

const CODE_EXAMPLES = {
  curl: `curl -H "X-API-Key: your_api_key" \\
  "https://www.arenafi.org/api/v3?endpoint=rankings&limit=10"`,
  python: `import requests

resp = requests.get(
    "https://www.arenafi.org/api/v3",
    params={"endpoint": "rankings", "limit": 10},
    headers={"X-API-Key": "your_api_key"},
)
traders = resp.json()["data"]`,
  javascript: `const res = await fetch(
  "https://www.arenafi.org/api/v3?endpoint=rankings&limit=10",
  { headers: { "X-API-Key": "your_api_key" } }
);
const { data: traders } = await res.json();`,
}

// ---------------------------------------------------------------------------
// Styles (shared)
// ---------------------------------------------------------------------------

const card = {
  padding: tokens.spacing[5],
  borderRadius: tokens.radius.lg,
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-primary)',
} as const

const mono = tokens.typography.fontFamily.mono.join(', ')
const sans = tokens.typography.fontFamily.sans.join(', ')

const codeBadge = {
  padding: '2px 8px',
  borderRadius: 4,
  background: 'var(--color-bg-tertiary)',
  fontFamily: mono,
  fontSize: 12,
} as const

const preBlock = {
  padding: tokens.spacing[4],
  borderRadius: tokens.radius.md,
  background: 'var(--color-bg-tertiary)',
  fontFamily: mono,
  fontSize: 13,
  overflow: 'auto' as const,
  lineHeight: 1.6,
} as const

const copyBtn = {
  position: 'absolute' as const,
  top: 8,
  right: 8,
  padding: '4px 10px',
  borderRadius: tokens.radius.sm,
  background: 'var(--color-bg-secondary)',
  border: '1px solid var(--color-border-primary)',
  color: 'var(--color-text-secondary)',
  fontFamily: sans,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  zIndex: 1,
} as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default async function ApiDocsPage() {
  const productFacts = buildProductFactsSnapshot(await getHeroStats())
  const { t } = await getServerTranslation()

  return (
    <div
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: `${tokens.spacing[8]} ${tokens.spacing[5]}`,
        color: 'var(--color-text-primary)',
        fontFamily: sans,
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
.apiEndpointsLayout{display:grid;grid-template-columns:1fr;gap:24px}
.apiEndpointIndex ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.apiEndpointIndex a{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--color-text-secondary);font-size:13px;border:1px solid var(--color-border-primary)}
.apiEndpointIndex a:hover{color:var(--color-text-primary);background:var(--color-bg-tertiary)}
@media(min-width:880px){
  .apiEndpointsLayout{grid-template-columns:200px minmax(0,1fr);align-items:start}
  .apiEndpointIndex{position:sticky;top:88px}
  .apiEndpointIndex ul{flex-direction:column;gap:4px}
  .apiEndpointIndex a{border:none;padding:6px 8px}
}
`,
        }}
      />

      {/* Hero */}
      <div style={{ marginBottom: tokens.spacing[10], textAlign: 'center' }}>
        <h1
          style={{
            fontSize: 'clamp(28px, 3.5vw, 40px)',
            fontWeight: tokens.typography.fontWeight.black,
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            marginBottom: tokens.spacing[3],
          }}
        >
          Arena Data API
        </h1>
        <p
          style={{
            fontSize: tokens.typography.fontSize.lg,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.6,
            maxWidth: 640,
            margin: '0 auto',
          }}
        >
          Crypto trader rankings across {productFacts.sourceBoardCount}+ live source boards.
          Risk-adjusted scores, equity curves, and performance data — leaderboard recomputed every{' '}
          {productFacts.leaderboardRefreshLabel}.
        </p>
      </div>

      {/* Pricing tiers (client component with Stripe checkout) */}
      <ApiPricingSection />

      {/* Quick start */}
      <section style={{ marginBottom: tokens.spacing[10] }}>
        <h2
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: 700,
            marginBottom: tokens.spacing[5],
          }}
        >
          Quick Start
        </h2>

        <div style={{ ...card, marginBottom: tokens.spacing[4] }}>
          <h3
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              marginBottom: tokens.spacing[2],
              color: 'var(--color-text-secondary)',
            }}
          >
            Authentication
          </h3>
          <p
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: 'var(--color-text-secondary)',
              marginBottom: tokens.spacing[3],
              lineHeight: 1.6,
            }}
          >
            Free tier requires no authentication — just call the endpoint. For higher limits, pass
            your API key via the <code style={codeBadge}>X-API-Key</code> header.
          </p>

          {Object.entries(CODE_EXAMPLES).map(([lang, code]) => (
            <div key={lang} style={{ marginBottom: tokens.spacing[3] }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase' as const,
                  color: 'var(--color-text-tertiary)',
                  marginBottom: tokens.spacing[1],
                  letterSpacing: '0.05em',
                }}
              >
                {lang}
              </div>
              <div data-copy-block style={{ position: 'relative' }}>
                <button type="button" data-copy-btn style={copyBtn}>
                  {t('copy')}
                </button>
                <pre tabIndex={0} style={preBlock}>
                  {code}
                </pre>
              </div>
            </div>
          ))}
        </div>

        <div style={card}>
          <h3
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              marginBottom: tokens.spacing[2],
              color: 'var(--color-text-secondary)',
            }}
          >
            Base URL
          </h3>
          <div data-copy-block style={{ position: 'relative' }}>
            <button type="button" data-copy-btn style={copyBtn}>
              {t('copy')}
            </button>
            <pre tabIndex={0} style={{ ...preBlock, fontSize: 14 }}>
              https://www.arenafi.org/api/v3
            </pre>
          </div>
          <p
            style={{
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
              marginTop: tokens.spacing[2],
            }}
          >
            All endpoints use the <code style={codeBadge}>endpoint</code> query parameter to select
            the resource.
          </p>
        </div>

        <div style={{ ...card, marginTop: tokens.spacing[4] }}>
          <h3
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              marginBottom: tokens.spacing[2],
              color: 'var(--color-text-secondary)',
            }}
          >
            CSV export
          </h3>
          <p
            style={{
              fontSize: tokens.typography.fontSize.sm,
              color: 'var(--color-text-secondary)',
              marginBottom: tokens.spacing[3],
              lineHeight: 1.6,
            }}
          >
            Append <code style={codeBadge}>format=csv</code> to a list endpoint (rankings, search,
            platforms, history, or bulk) to download RFC-4180 CSV instead of JSON. Single-trader
            detail remains JSON.
          </p>
          <div data-copy-block style={{ position: 'relative' }}>
            <button type="button" data-copy-btn style={copyBtn}>
              {t('copy')}
            </button>
            <pre tabIndex={0} style={preBlock}>
              {`curl "https://www.arenafi.org/api/v3?endpoint=rankings&period=90D&limit=200&format=csv"`}
            </pre>
          </div>
        </div>
      </section>

      {/* Endpoints */}
      <section id="endpoints" style={{ marginBottom: tokens.spacing[10] }}>
        <h2
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: 700,
            marginBottom: tokens.spacing[5],
          }}
        >
          Endpoints
        </h2>

        <div className="apiEndpointsLayout">
          <nav className="apiEndpointIndex" aria-label={t('apiDocsOnThisPage')}>
            <ul>
              {ENDPOINTS.map((ep) => (
                <li key={ep.name}>
                  <a href={`#${epId(ep.name)}`}>
                    <span
                      style={{
                        fontFamily: mono,
                        fontSize: 10,
                        fontWeight: 700,
                        color: 'var(--color-accent-success)',
                      }}
                    >
                      {ep.method}
                    </span>
                    {ep.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="apiEndpointList">
            {ENDPOINTS.map((ep) => (
              <div
                key={ep.name}
                id={epId(ep.name)}
                style={{ ...card, marginBottom: tokens.spacing[5], scrollMarginTop: 88 }}
              >
                {/* Name (heading + anchor target) */}
                <h3
                  style={{
                    fontSize: tokens.typography.fontSize.lg,
                    fontWeight: 700,
                    marginTop: 0,
                    marginBottom: tokens.spacing[3],
                  }}
                >
                  {ep.name}
                </h3>
                {/* Method + path */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    marginBottom: tokens.spacing[3],
                  }}
                >
                  <span
                    style={{
                      padding: '2px 10px',
                      borderRadius: tokens.radius.sm,
                      background: alpha(tokens.colors.accent.success, 15),
                      color: 'var(--color-accent-success)',
                      fontSize: 12,
                      fontWeight: 700,
                      fontFamily: mono,
                    }}
                  >
                    {ep.method}
                  </span>
                  <code style={{ fontSize: 14, fontWeight: 600, fontFamily: mono }}>{ep.path}</code>
                </div>
                <p
                  style={{
                    fontSize: tokens.typography.fontSize.sm,
                    color: 'var(--color-text-secondary)',
                    marginBottom: tokens.spacing[4],
                    lineHeight: 1.6,
                  }}
                >
                  {ep.description}
                </p>

                {/* Parameters */}
                <h4
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: tokens.spacing[2],
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  Parameters
                </h4>
                <div
                  style={{
                    borderRadius: tokens.radius.md,
                    border: '1px solid var(--color-border-primary)',
                    overflow: 'hidden',
                    marginBottom: tokens.spacing[4],
                  }}
                >
                  {ep.params.map((p, i) => (
                    <div
                      key={p.name}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 70px 1fr',
                        gap: tokens.spacing[3],
                        padding: '8px 12px',
                        fontSize: 13,
                        borderBottom:
                          i < ep.params.length - 1
                            ? '1px solid var(--color-border-primary)'
                            : undefined,
                        background: i % 2 === 0 ? 'var(--color-bg-tertiary)' : 'transparent',
                      }}
                    >
                      <code style={{ fontFamily: mono, fontWeight: 600 }}>{p.name}</code>
                      <span style={{ color: 'var(--color-text-tertiary)', fontSize: 12 }}>
                        {p.required ? 'required' : 'optional'}
                      </span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>{p.description}</span>
                    </div>
                  ))}
                </div>

                {/* Example */}
                <h4
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: tokens.spacing[2],
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  Example
                </h4>
                <div
                  data-copy-block
                  style={{ position: 'relative', marginBottom: tokens.spacing[2] }}
                >
                  <button type="button" data-copy-btn style={copyBtn}>
                    {t('copy')}
                  </button>
                  <pre
                    tabIndex={0}
                    style={{
                      ...preBlock,
                      fontSize: 12,
                      color: 'var(--color-accent-success)',
                    }}
                  >
                    {ep.example.curl}
                  </pre>
                </div>
                <div data-copy-block style={{ position: 'relative' }}>
                  <button type="button" data-copy-btn style={copyBtn}>
                    {t('copy')}
                  </button>
                  <pre tabIndex={0} style={{ ...preBlock, fontSize: 11, maxHeight: 320 }}>
                    {ep.example.response}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Copy-to-clipboard wiring (progressive enhancement) */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){
var COPY=${JSON.stringify(t('copy'))},COPIED=${JSON.stringify(t('copied'))};
document.addEventListener("click",function(e){
var btn=e.target&&e.target.closest?e.target.closest("[data-copy-btn]"):null;
if(!btn)return;
var block=btn.closest("[data-copy-block]");if(!block)return;
var pre=block.querySelector("pre");if(!pre)return;
var text=pre.innerText||pre.textContent||"";
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){btn.textContent=COPIED;setTimeout(function(){btn.textContent=COPY;},1500);}).catch(function(){});}
});
})();`,
        }}
      />

      {/* Rate limits */}
      <section style={{ marginBottom: tokens.spacing[10] }}>
        <h2
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: 700,
            marginBottom: tokens.spacing[5],
          }}
        >
          Rate Limits
        </h2>
        <div style={card}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: tokens.spacing[4],
            }}
          >
            {[
              { tier: 'Free', limit: '100 req/day', auth: 'None (IP-based)' },
              { tier: 'Starter', limit: '10,000 req/day', auth: 'X-API-Key header' },
              { tier: 'Pro', limit: 'Unlimited', auth: 'X-API-Key header' },
            ].map((r) => (
              <div key={r.tier}>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: 600,
                    marginBottom: tokens.spacing[1],
                  }}
                >
                  {r.tier}
                </div>
                <div
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    color: 'var(--color-text-secondary)',
                    marginBottom: 2,
                  }}
                >
                  {r.limit}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{r.auth}</div>
              </div>
            ))}
          </div>
          <p
            style={{
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
              marginTop: tokens.spacing[4],
              lineHeight: 1.6,
            }}
          >
            Rate limit status is included in every response under{' '}
            <code style={codeBadge}>meta.rate_limit</code>. When exceeded, the API returns{' '}
            <code style={codeBadge}>429</code> with a <code style={codeBadge}>Retry-After</code>{' '}
            header.
          </p>
        </div>
      </section>

      {/* CTA */}
      <div
        style={{
          ...card,
          textAlign: 'center',
          padding: tokens.spacing[8],
        }}
      >
        <h2
          style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: 700,
            marginBottom: tokens.spacing[2],
          }}
        >
          Ready to get started?
        </h2>
        <p
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-secondary)',
            marginBottom: tokens.spacing[5],
          }}
        >
          Start with 100 free requests/day — no sign-up required.
          <br />
          Create an API key in settings for higher limits.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: tokens.spacing[3] }}>
          <a
            href="#endpoints"
            style={{
              display: 'inline-block',
              padding: '10px 28px',
              borderRadius: tokens.radius.md,
              background: 'var(--color-brand-deep)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Try the API
          </a>
          <a
            href="/settings#api-keys"
            style={{
              display: 'inline-block',
              padding: '10px 28px',
              borderRadius: tokens.radius.md,
              background: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
              border: '1px solid var(--color-border-primary)',
            }}
          >
            Get API Key
          </a>
        </div>
      </div>
    </div>
  )
}
