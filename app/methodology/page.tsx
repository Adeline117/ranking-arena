import React from 'react'
import { Metadata } from 'next'
import Link from 'next/link'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 3600 // ISR: 1 hour (static content)

export const metadata: Metadata = {
  title: 'Arena Score Methodology — How We Rank Traders',
  description:
    'Learn how Arena calculates trader rankings from 25+ exchanges. Our methodology evaluates ROI, PnL, and risk metrics using the Arena Score algorithm for transparent, cross-exchange trader ranking.',
  alternates: {
    canonical: `${BASE_URL}/methodology`,
  },
  openGraph: {
    title: 'Arena Score Methodology — How We Rank Crypto Traders',
    description:
      'Learn how Arena Score is calculated from 25+ exchanges to rank the top crypto traders. Transparent methodology for ROI, PnL, and risk evaluation.',
    url: `${BASE_URL}/methodology`,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: `${BASE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: 'Arena Methodology',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena Score Methodology — How We Rank Traders',
    description:
      'Learn how Arena Score is calculated from 25+ exchanges to rank the top crypto traders.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

/* ---------- styles ---------- */

const containerStyle: React.CSSProperties = {
  maxWidth: 800,
  margin: '0 auto',
  padding: '64px 24px 96px',
  color: 'var(--color-text-primary)',
  lineHeight: 1.7,
}

const h1Style: React.CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  marginBottom: 8,
}

const subtitleStyle: React.CSSProperties = {
  fontSize: 16,
  color: 'var(--color-text-secondary)',
  marginBottom: 48,
}

const sectionStyle: React.CSSProperties = { marginBottom: 48 }

const h2Style: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  marginBottom: 16,
  color: 'var(--color-text-primary)',
}

const bodyStyle: React.CSSProperties = {
  fontSize: 15,
  color: 'var(--color-text-secondary)',
}

const listStyle: React.CSSProperties = {
  paddingLeft: 20,
  marginTop: 12,
}

const liStyle: React.CSSProperties = { marginBottom: 8 }

const codeStyle: React.CSSProperties = {
  background: 'var(--color-bg-tertiary)',
  padding: '2px 6px',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'monospace',
}

const formulaBoxStyle: React.CSSProperties = {
  padding: '20px 24px',
  background: 'var(--color-bg-secondary)',
  borderRadius: 12,
  border: '1px solid var(--color-border-primary)',
  fontFamily: 'monospace',
  fontSize: 14,
  lineHeight: 2,
  marginTop: 16,
  overflow: 'auto',
}

const badgeRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  marginTop: 16,
  flexWrap: 'wrap',
}

const calloutStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderRadius: 12,
  border: '1px solid var(--color-border-primary)',
  marginTop: 16,
}

const faqStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderRadius: 12,
  marginBottom: 16,
}

const dividerStyle: React.CSSProperties = {
  margin: '64px 0',
  borderTop: '2px solid var(--color-border-primary)',
}

/* ---------- page ---------- */

export default function MethodologyPage() {
  return (
    <div style={containerStyle}>
      {/* ======================= ENGLISH ======================= */}
      <h1 style={h1Style}>Methodology</h1>
      <p style={subtitleStyle}>
        How Arena ranks crypto traders across 25+ exchanges &mdash; transparent, data-driven, updated every 30 minutes
      </p>

      {/* Data Sources */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Data Sources</h2>
        <div style={bodyStyle}>
          <p>
            Arena aggregates publicly available trading data from <strong>25+ centralized
            and decentralized exchanges</strong>, including:
          </p>
          <ul style={listStyle}>
            <li style={liStyle}>
              <strong>CEX:</strong> Binance Futures, Binance Spot, Bybit, OKX, Bitget,
              MEXC, HTX, Gate.io, CoinEx, BingX, BTCC, Bitfinex, Bitunix, eToro, and more
            </li>
            <li style={liStyle}>
              <strong>DEX:</strong> Hyperliquid, GMX, dYdX, Vertex, Drift, Aevo, Gains
              Network, Kwenta, and more
            </li>
          </ul>
          <p style={{ marginTop: 12 }}>
            Data is collected via official exchange APIs and, for geo-restricted or
            WAF-protected exchanges, through VPS-based scrapers deployed in multiple
            regions (Singapore, Japan).
          </p>
        </div>
      </section>

      {/* Update Frequency */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Update Frequency</h2>
        <div style={bodyStyle}>
          <div style={calloutStyle}>
            <ul style={{ ...listStyle, marginTop: 0 }}>
              <li style={liStyle}>
                <strong>CEX data:</strong> Refreshed every <code style={codeStyle}>3-6 hours</code>
              </li>
              <li style={liStyle}>
                <strong>DEX data:</strong> Refreshed every <code style={codeStyle}>4 hours</code>
              </li>
              <li style={liStyle}>
                <strong>Leaderboard:</strong> Recomputed every <code style={codeStyle}>30 minutes</code>
              </li>
              <li style={liStyle}>
                <strong>Stale threshold:</strong> Data older than 48 hours (CEX) or 72 hours
                (DEX) is excluded from composite score computation
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Arena Score Algorithm */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Arena Score Algorithm (0-100)</h2>
        <div style={bodyStyle}>
          <p>
            The Arena Score is a composite rating designed to measure <strong>risk-adjusted
            performance</strong> across exchanges. It consists of two primary components:
          </p>

          <div style={formulaBoxStyle}>
            <div><strong>Return Score (0-60 points)</strong></div>
            <div>ReturnScore = 60 &times; tanh(coefficient &times; ROI)<sup>exponent</sup></div>
            <br />
            <div><strong>PnL Score (0-40 points)</strong></div>
            <div>PnlScore = 40 &times; tanh(coefficient &times; ln(1 + PnL / base))</div>
            <br />
            <div><strong>Final Score</strong></div>
            <div>ArenaScore = (ReturnScore + PnlScore) &times; confidenceMultiplier &times; trustWeight</div>
          </div>

          <p style={{ marginTop: 16 }}>
            The <code style={codeStyle}>tanh</code> (hyperbolic tangent) normalization
            creates diminishing returns for extreme values, preventing a single outlier
            trade from dominating rankings. Coefficients and exponents vary by time period
            to appropriately weight short vs. long-term performance.
          </p>

          <p style={{ marginTop: 12 }}>
            <strong>Confidence multiplier</strong> accounts for data completeness &mdash;
            traders missing key metrics (win rate, max drawdown) receive a penalty (0.80-0.92x).
          </p>
        </div>
      </section>

      {/* Time Windows */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Time Windows &amp; Composite Score</h2>
        <div style={bodyStyle}>
          <p>
            Rankings are computed across three time windows. The overall composite score
            heavily weights long-term consistency:
          </p>
          <div style={badgeRowStyle}>
            <WeightBadge period="90D" weight="70%" />
            <WeightBadge period="30D" weight="25%" />
            <WeightBadge period="7D" weight="5%" />
          </div>
          <p style={{ marginTop: 16 }}>
            This weighting rewards traders who maintain strong, consistent performance
            over months rather than those with short-term spikes.
          </p>
        </div>
      </section>

      {/* Cross-Exchange Normalization */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Cross-Exchange Normalization</h2>
        <div style={bodyStyle}>
          <p>
            Different exchanges report ROI and PnL in different ways:
          </p>
          <ul style={listStyle}>
            <li style={liStyle}>
              Some report the trader&apos;s own PnL, others report followers&apos;
              copy-trading PnL
            </li>
            <li style={liStyle}>
              ROI may be expressed as a ratio (0.25) or percentage (25%)
            </li>
            <li style={liStyle}>
              Some exchanges include unrealized PnL, others only realized
            </li>
          </ul>
          <p style={{ marginTop: 12 }}>
            Arena normalizes all values to a consistent format (ROI as percentage, PnL
            in USD) during data ingestion. A per-exchange <code style={codeStyle}>trustWeight</code> factor
            adjusts for data quality and reporting standards.
          </p>
        </div>
      </section>

      {/* Anti-Gaming */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Anti-Gaming Measures</h2>
        <div style={bodyStyle}>
          <ul style={listStyle}>
            <li style={liStyle}>
              <strong>Tanh normalization:</strong> Caps extreme ROI values &mdash; 10,000%
              ROI scores only marginally higher than 1,000%
            </li>
            <li style={liStyle}>
              <strong>Outlier detection:</strong> Statistical checks flag abnormal jumps
              in ROI or PnL between snapshots
            </li>
            <li style={liStyle}>
              <strong>Minimum requirements:</strong> Traders must meet minimum trade count
              and data availability thresholds
            </li>
            <li style={liStyle}>
              <strong>Server-side computation:</strong> Scores are computed on our servers
              and cannot be self-reported
            </li>
            <li style={liStyle}>
              <strong>Data freshness filter:</strong> Only data within the freshness
              threshold contributes to rankings
            </li>
          </ul>
        </div>
      </section>

      {/* Data Limitations */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Data Limitations</h2>
        <div style={bodyStyle}>
          <p>We believe in transparency about what our data can and cannot tell you:</p>
          <ul style={listStyle}>
            <li style={liStyle}>
              Exchange APIs may have delays of 1-6 hours depending on the platform
            </li>
            <li style={liStyle}>
              Some exchanges do not expose all metrics (e.g., max drawdown, Sharpe ratio)
            </li>
            <li style={liStyle}>
              Geo-restrictions may cause temporary data gaps for certain exchanges
            </li>
            <li style={liStyle}>
              DEX data depends on blockchain indexers which may lag during congestion
            </li>
            <li style={liStyle}>
              Rankings reflect historical performance only and do not predict future results
            </li>
          </ul>
        </div>
      </section>

      {/* FAQ */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Frequently Asked Questions</h2>
        <div style={bodyStyle}>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Q: Why does my favorite trader have a lower score than expected?
            </p>
            <p style={{ margin: 0 }}>
              A: Arena Score weighs long-term consistency (90D = 70%). A trader with
              spectacular short-term gains but inconsistent history may score lower than
              a steady performer. Data completeness also affects scores &mdash; missing
              metrics result in a confidence penalty.
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Q: How often are rankings updated?
            </p>
            <p style={{ margin: 0 }}>
              A: Raw data is fetched every 3-6 hours. The leaderboard is recomputed every
              30 minutes using the latest available data.
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Q: Can I compare traders across different exchanges?
            </p>
            <p style={{ margin: 0 }}>
              A: Yes, that is the primary purpose of Arena Score. However, for the most
              accurate comparison, we recommend also checking the per-exchange rankings,
              as data reporting standards vary between platforms.
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Q: Why is a trader I follow on an exchange not appearing on Arena?
            </p>
            <p style={{ margin: 0 }}>
              A: We fetch the top-ranked traders from each exchange. If a trader is not in
              the exchange&apos;s public leaderboard or has insufficient data, they may not
              appear. We currently track 34,000+ traders across all platforms.
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Q: Is Arena Score the same as ROI?
            </p>
            <p style={{ margin: 0 }}>
              A: No. Arena Score is a composite metric that combines ROI, absolute PnL,
              and data quality factors. A trader with moderate ROI but large consistent
              profits may score higher than one with extremely high ROI but tiny PnL.
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              Q: Does Arena provide trading signals or advice?
            </p>
            <p style={{ margin: 0 }}>
              A: No. Arena is a data platform. We rank traders based on historical
              performance data. We do not provide financial advice, trading signals, or
              recommendations. Always do your own research.
            </p>
          </div>
        </div>
      </section>

      {/* ======================= DIVIDER ======================= */}
      <div style={dividerStyle} />

      {/* ======================= CHINESE ======================= */}
      <h1 style={h1Style}>方法论</h1>
      <p style={subtitleStyle}>
        Arena 如何对 25+ 交易所的加密交易者进行排名 &mdash; 透明、数据驱动、每 30 分钟更新
      </p>

      {/* 数据来源 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>数据来源</h2>
        <div style={bodyStyle}>
          <p>
            Arena 从 <strong>25 多个中心化和去中心化交易所</strong> 聚合公开的交易数据，包括：
          </p>
          <ul style={listStyle}>
            <li style={liStyle}>
              <strong>CEX：</strong>Binance Futures、Binance Spot、Bybit、OKX、Bitget、MEXC、HTX、Gate.io、CoinEx、BingX、BTCC、Bitfinex、Bitunix、eToro 等
            </li>
            <li style={liStyle}>
              <strong>DEX：</strong>Hyperliquid、GMX、dYdX、Vertex、Drift、Aevo、Gains Network、Kwenta 等
            </li>
          </ul>
          <p style={{ marginTop: 12 }}>
            数据通过官方交易所 API 收集，对于有地理限制或 WAF 保护的交易所，则通过部署在多个地区（新加坡、日本）的 VPS 爬虫收集。
          </p>
        </div>
      </section>

      {/* 更新频率 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>更新频率</h2>
        <div style={bodyStyle}>
          <div style={calloutStyle}>
            <ul style={{ ...listStyle, marginTop: 0 }}>
              <li style={liStyle}>
                <strong>CEX 数据：</strong>每 <code style={codeStyle}>3-6 小时</code> 刷新
              </li>
              <li style={liStyle}>
                <strong>DEX 数据：</strong>每 <code style={codeStyle}>4 小时</code> 刷新
              </li>
              <li style={liStyle}>
                <strong>排行榜：</strong>每 <code style={codeStyle}>30 分钟</code> 重新计算
              </li>
              <li style={liStyle}>
                <strong>过期阈值：</strong>超过 48 小时（CEX）或 72 小时（DEX）的数据将被排除在综合评分计算之外
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Arena Score 算法 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Arena Score 算法 (0-100)</h2>
        <div style={bodyStyle}>
          <p>
            Arena Score 是一个综合评分，旨在衡量跨交易所的<strong>风险调整绩效</strong>。它由两个主要部分组成：
          </p>

          <div style={formulaBoxStyle}>
            <div><strong>回报得分 (0-60 分)</strong></div>
            <div>ReturnScore = 60 &times; tanh(coefficient &times; ROI)<sup>exponent</sup></div>
            <br />
            <div><strong>盈亏得分 (0-40 分)</strong></div>
            <div>PnlScore = 40 &times; tanh(coefficient &times; ln(1 + PnL / base))</div>
            <br />
            <div><strong>最终得分</strong></div>
            <div>ArenaScore = (ReturnScore + PnlScore) &times; confidenceMultiplier &times; trustWeight</div>
          </div>

          <p style={{ marginTop: 16 }}>
            <code style={codeStyle}>tanh</code>（双曲正切）归一化为极端值创造递减收益，防止单笔异常交易主导排名。系数和指数因时间周期而异，以适当权衡短期与长期绩效。
          </p>

          <p style={{ marginTop: 12 }}>
            <strong>置信度乘数</strong>考虑数据完整性 — 缺少关键指标（胜率、最大回撤）的交易者将受到惩罚（0.80-0.92 倍）。
          </p>
        </div>
      </section>

      {/* 时间窗口 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>时间窗口与综合评分</h2>
        <div style={bodyStyle}>
          <p>排名在三个时间窗口上计算。综合评分高度侧重长期一致性：</p>
          <div style={badgeRowStyle}>
            <WeightBadge period="90D" weight="70%" />
            <WeightBadge period="30D" weight="25%" />
            <WeightBadge period="7D" weight="5%" />
          </div>
          <p style={{ marginTop: 16 }}>
            这种权重设计奖励数月内保持强劲、稳定表现的交易者，而非仅有短期爆发的交易者。
          </p>
        </div>
      </section>

      {/* 跨交易所归一化 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>跨交易所归一化</h2>
        <div style={bodyStyle}>
          <p>不同交易所以不同方式报告 ROI 和 PnL：</p>
          <ul style={listStyle}>
            <li style={liStyle}>有些报告交易者自身的 PnL，有些报告跟单者的 PnL</li>
            <li style={liStyle}>ROI 可能以比率 (0.25) 或百分比 (25%) 表示</li>
            <li style={liStyle}>有些交易所包含未实现 PnL，有些仅包含已实现 PnL</li>
          </ul>
          <p style={{ marginTop: 12 }}>
            Arena 在数据摄入期间将所有值归一化为一致格式（ROI 为百分比，PnL 为美元）。每个交易所的 <code style={codeStyle}>trustWeight</code> 因子根据数据质量和报告标准进行调整。
          </p>
        </div>
      </section>

      {/* 反作弊措施 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>反作弊措施</h2>
        <div style={bodyStyle}>
          <ul style={listStyle}>
            <li style={liStyle}>
              <strong>tanh 归一化：</strong>限制极端 ROI 值 — 10,000% ROI 的得分仅略高于 1,000%
            </li>
            <li style={liStyle}>
              <strong>异常检测：</strong>统计检查标记快照之间 ROI 或 PnL 的异常跳跃
            </li>
            <li style={liStyle}>
              <strong>最低要求：</strong>交易者必须满足最低交易次数和数据可用性阈值
            </li>
            <li style={liStyle}>
              <strong>服务端计算：</strong>评分在我们的服务器上计算，不能自行报告
            </li>
            <li style={liStyle}>
              <strong>数据新鲜度过滤：</strong>只有在新鲜度阈值内的数据才会纳入排名
            </li>
          </ul>
        </div>
      </section>

      {/* 数据局限性 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>数据局限性</h2>
        <div style={bodyStyle}>
          <p>我们相信对数据能做什么和不能做什么保持透明：</p>
          <ul style={listStyle}>
            <li style={liStyle}>交易所 API 可能有 1-6 小时的延迟，具体取决于平台</li>
            <li style={liStyle}>部分交易所不公开所有指标（如最大回撤、夏普比率）</li>
            <li style={liStyle}>地理限制可能导致某些交易所的数据暂时中断</li>
            <li style={liStyle}>DEX 数据依赖区块链索引器，在链上拥堵时可能延迟</li>
            <li style={liStyle}>排名仅反映历史表现，不预测未来收益</li>
          </ul>
        </div>
      </section>

      {/* 常见问题 */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>常见问题</h2>
        <div style={bodyStyle}>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              问：为什么我关注的交易者评分比预期低？
            </p>
            <p style={{ margin: 0 }}>
              答：Arena Score 侧重长期一致性（90D = 70%）。短期表现出色但历史不稳定的交易者可能得分低于稳定表现的交易者。数据完整性也会影响评分 — 缺少指标会导致置信度惩罚。
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              问：排名多久更新一次？
            </p>
            <p style={{ margin: 0 }}>
              答：原始数据每 3-6 小时获取一次。排行榜每 30 分钟使用最新可用数据重新计算。
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              问：可以比较不同交易所的交易者吗？
            </p>
            <p style={{ margin: 0 }}>
              答：可以，这正是 Arena Score 的主要目的。但为了最准确的比较，我们建议同时查看各交易所的排名，因为数据报告标准因平台而异。
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              问：为什么我在某交易所关注的交易者没有出现在 Arena 上？
            </p>
            <p style={{ margin: 0 }}>
              答：我们从每个交易所获取排名靠前的交易者。如果交易者不在交易所的公开排行榜中或数据不足，可能不会出现。我们目前跟踪所有平台的 34,000 多名交易者。
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              问：Arena Score 和 ROI 一样吗？
            </p>
            <p style={{ margin: 0 }}>
              答：不一样。Arena Score 是结合 ROI、绝对 PnL 和数据质量因素的综合指标。ROI 适中但利润大且稳定的交易者可能得分高于 ROI 极高但 PnL 很小的交易者。
            </p>
          </div>
          <div style={faqStyle}>
            <p style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>
              问：Arena 提供交易信号或建议吗？
            </p>
            <p style={{ margin: 0 }}>
              答：不提供。Arena 是一个数据平台。我们根据历史绩效数据对交易者进行排名。我们不提供财务建议、交易信号或推荐。请始终进行自己的研究。
            </p>
          </div>
        </div>
      </section>

      {/* Back link */}
      <div
        style={{
          marginTop: 64,
          paddingTop: 24,
          borderTop: '1px solid var(--color-border-primary)',
        }}
      >
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
    </div>
  )
}

/* ---------- sub-components ---------- */

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
