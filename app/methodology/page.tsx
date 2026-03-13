import { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'How Arena Ranks Traders | Methodology',
  description:
    'Learn how Arena collects data from 30+ exchanges and calculates the Arena Score to rank crypto traders.',
}

export default function MethodologyPage() {
  return (
    <main
      style={{
        maxWidth: 800,
        margin: '0 auto',
        padding: '64px 24px 96px',
        color: 'var(--color-text-primary)',
        lineHeight: 1.7,
      }}
    >
      <h1
        style={{
          fontSize: 32,
          fontWeight: 700,
          marginBottom: 8,
          color: 'var(--color-text-primary)',
        }}
      >
        Methodology
      </h1>
      <p
        style={{
          fontSize: 16,
          color: 'var(--color-text-secondary)',
          marginBottom: 48,
        }}
      >
        How Arena ranks crypto traders across 30+ exchanges
      </p>

      {/* Section 1 */}
      <Section title="How We Collect Data">
        <p>
          Arena aggregates public trading data from 30+ centralized and
          decentralized exchanges including Binance, Bybit, OKX, Bitget,
          Hyperliquid, dYdX, GMX, and more. Data is collected via official APIs
          and refreshed every 3-6 hours.
        </p>
      </Section>

      {/* Section 2 */}
      <Section title="Arena Score (0-100)">
        <p>
          The Arena Score is a composite rating that evaluates traders on four
          dimensions:
        </p>
        <ul style={{ paddingLeft: 20, marginTop: 16 }}>
          <ScoreItem label="Return Score" range="0-70">
            Based on ROI using tanh normalization to prevent extreme outliers
            from distorting rankings.
          </ScoreItem>
          <ScoreItem label="PnL Score" range="0-15">
            Based on absolute profit in USD, log-scaled to balance large and
            small accounts.
          </ScoreItem>
          <ScoreItem label="Drawdown Score" range="0-8">
            Lower max drawdown equals a higher score. Rewards consistent risk
            management.
          </ScoreItem>
          <ScoreItem label="Stability Score" range="0-7">
            Based on win rate consistency across the evaluation window.
          </ScoreItem>
        </ul>
      </Section>

      {/* Section 3 */}
      <Section title="Time Windows">
        <p>
          Rankings are computed across three time windows:{' '}
          <strong>7-day</strong>, <strong>30-day</strong>, and{' '}
          <strong>90-day</strong>.
        </p>
        <p style={{ marginTop: 12 }}>
          The composite score weights these periods to favor long-term
          consistency:
        </p>
        <div
          style={{
            display: 'flex',
            gap: 16,
            marginTop: 16,
            flexWrap: 'wrap',
          }}
        >
          <WeightBadge period="90D" weight="70%" />
          <WeightBadge period="30D" weight="25%" />
          <WeightBadge period="7D" weight="5%" />
        </div>
      </Section>

      {/* Section 4 */}
      <Section title="Data Freshness">
        <p>
          CEX data refreshes every <strong>3 hours</strong>. DEX data refreshes
          every <strong>4-6 hours</strong>. If data from a platform is older than
          48 hours, it is flagged as stale and excluded from composite score
          computation.
        </p>
      </Section>

      {/* Section 5 */}
      <Section title="Exchange-Specific Notes">
        <p>
          ROI calculation varies by exchange. Some platforms report the
          trader&apos;s own PnL, while others report followers&apos;
          copy-trading PnL. Arena normalizes where possible, but we recommend
          comparing traders within the same exchange for the most accurate
          comparison.
        </p>
      </Section>

      {/* Section 6 */}
      <Section title="Confidence Scoring">
        <p>
          Traders with incomplete data (missing win rate or max drawdown) receive
          a confidence penalty that reduces their overall Arena Score:
        </p>
        <ul style={{ paddingLeft: 20, marginTop: 12 }}>
          <li style={{ marginBottom: 8 }}>
            <strong>Partial data</strong> (some metrics missing):{' '}
            <code style={codeStyle}>&times;0.92</code>
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>Minimal data</strong> (most metrics missing):{' '}
            <code style={codeStyle}>&times;0.80</code>
          </li>
        </ul>
      </Section>

      {/* Section 7 */}
      <Section title="Anti-Manipulation">
        <p>
          Arena Score uses <strong>tanh normalization</strong> to cap extreme ROI
          values and prevent manipulation. This mathematical function creates
          diminishing returns for extremely high ROIs, ensuring that no single
          outlier trade can dominate the rankings. Scores are computed
          server-side and cannot be self-reported.
        </p>
      </Section>

      {/* Back link */}
      <div style={{ marginTop: 64, paddingTop: 24, borderTop: '1px solid var(--color-border-primary)' }}>
        <Link
          href="/rankings"
          style={{
            color: 'var(--color-accent-primary)',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          &larr; Back to Rankings
        </Link>
      </div>
    </main>
  )
}

/* ------------------------------------------------------------------ */
/*  Sub-components (server, co-located)                                */
/* ------------------------------------------------------------------ */

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section style={{ marginBottom: 40 }}>
      <h2
        style={{
          fontSize: 20,
          fontWeight: 600,
          marginBottom: 12,
          color: 'var(--color-text-primary)',
        }}
      >
        {title}
      </h2>
      <div style={{ fontSize: 15, color: 'var(--color-text-secondary)' }}>
        {children}
      </div>
    </section>
  )
}

function ScoreItem({
  label,
  range,
  children,
}: {
  label: string
  range: string
  children: React.ReactNode
}) {
  return (
    <li style={{ marginBottom: 12 }}>
      <strong style={{ color: 'var(--color-text-primary)' }}>
        {label} ({range})
      </strong>
      <br />
      <span>{children}</span>
    </li>
  )
}

function WeightBadge({ period, weight }: { period: string; weight: string }) {
  return (
    <div
      style={{
        padding: '8px 16px',
        borderRadius: 8,
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-border-primary)',
        fontSize: 14,
        fontWeight: 500,
        color: 'var(--color-text-primary)',
      }}
    >
      {period}{' '}
      <span style={{ color: 'var(--color-accent-primary)' }}>{weight}</span>
    </div>
  )
}

const codeStyle: React.CSSProperties = {
  background: 'var(--color-bg-tertiary)',
  padding: '2px 6px',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'monospace',
}
