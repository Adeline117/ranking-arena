export interface Article {
  slug: string
  title: string
  excerpt: string
  content: string
}

export const ARTICLES: Article[] = [
  {
    slug: 'how-arena-score-works',
    title: 'How Arena Score Works',
    excerpt:
      'Understand the formula behind Arena Score, combining ROI, PnL, and confidence multipliers into a single 0-100 rating.',
    content: `
# How Arena Score Works

Arena Score is a composite metric that rates every trader on a **0-100 scale**. It combines two core dimensions:

## Return Score (0-60 points)

The return score captures ROI using a tanh curve that rewards consistent returns while capping outliers:

\`ReturnScore = 60 * tanh(coeff * ROI)^exponent\`

This means a trader with 50% ROI in 90 days scores significantly higher than one who spiked 200% then crashed.

## PnL Score (0-40 points)

Absolute profit matters too. A 100% ROI on $100 is less impressive than 20% ROI on $1M:

\`PnlScore = 40 * tanh(coeff * ln(1 + PnL / base))\`

The logarithmic scaling ensures diminishing returns for extremely large PnL values.

## Confidence & Trust

Each score is adjusted by:
- **Confidence multiplier**: Penalizes traders with missing data (no drawdown or win rate info)
- **Trust weight**: Some exchanges provide more reliable data than others

## Overall Composite

The final Arena Score weights multiple timeframes:
- **90-day score**: 70% weight
- **30-day score**: 25% weight
- **7-day score**: 5% weight

This ensures consistent long-term performers rank higher than flash-in-the-pan traders.
    `.trim(),
  },
  {
    slug: 'understanding-trader-rankings',
    title: 'Understanding Crypto Trader Rankings',
    excerpt:
      'How Arena aggregates rankings from 28+ exchanges into a single unified leaderboard with 34,000+ traders.',
    content: `
# Understanding Crypto Trader Rankings

Arena aggregates trader performance data from **28+ exchanges** — both centralized (CEX) and decentralized (DEX) — into a single unified leaderboard.

## Data Collection

Every few hours, our pipeline fetches leaderboard data from each exchange using their public APIs. This includes:
- **ROI** (Return on Investment) across multiple timeframes
- **PnL** (Profit and Loss) in USD
- **Win rate**, **max drawdown**, and other risk metrics when available

## Normalization

Different exchanges report data differently. Some give ROI as a decimal (0.25), others as a percentage (25%). Arena normalizes all data into consistent units before scoring.

## Ranking Methodology

1. **Fetch**: Collect raw data from all 28+ exchange APIs
2. **Normalize**: Convert to standard units (ROI in %, PnL in USD)
3. **Score**: Calculate Arena Score for each trader per timeframe
4. **Composite**: Compute overall score (90D x 0.70 + 30D x 0.25 + 7D x 0.05)
5. **Rank**: Sort by composite score, grouping ties

## Period Switching

You can view rankings for different periods:
- **7 Days**: Recent hot performers
- **30 Days**: Medium-term consistency
- **90 Days**: Long-term track record (default, highest weight)
    `.trim(),
  },
  {
    slug: 'cex-vs-dex',
    title: 'CEX vs DEX: Comparing Exchange Types',
    excerpt:
      'Learn the differences between centralized and decentralized exchanges, and how Arena ranks traders across both.',
    content: `
# CEX vs DEX: Comparing Exchange Types

Arena ranks traders from both **centralized exchanges (CEX)** and **decentralized exchanges (DEX)**. Here is how they compare.

## Centralized Exchanges (CEX)

Examples: Binance, Bybit, OKX, Bitget, MEXC

- **Data source**: Copy-trading leaderboards and public APIs
- **Pros**: Higher liquidity, more traders, faster execution
- **Cons**: Requires KYC, custodial (exchange holds your funds)
- **Data quality**: Generally complete (ROI, PnL, win rate, followers)

## Decentralized Exchanges (DEX)

Examples: Hyperliquid, GMX, dYdX, Drift, Vertex

- **Data source**: On-chain data and subgraph APIs
- **Pros**: Non-custodial, transparent, permissionless
- **Cons**: Lower liquidity, higher gas costs (on some chains)
- **Data quality**: Varies — some have rich on-chain analytics, others only basic PnL

## How Arena Handles Differences

- **Trust weights** adjust scores based on data reliability per exchange
- **Confidence multipliers** penalize traders with incomplete metrics
- **Normalization** ensures a Hyperliquid trader and a Binance trader are compared fairly

The result: a single leaderboard where the best traders rise to the top, regardless of where they trade.
    `.trim(),
  },
  {
    slug: 'reading-risk-metrics',
    title: 'Reading Risk Metrics',
    excerpt:
      'What drawdown, Sharpe ratio, and win rate really mean, and how to use them to evaluate traders.',
    content: `
# Reading Risk Metrics

High returns mean nothing without understanding risk. Arena provides several risk metrics to help you evaluate traders beyond just ROI.

## Max Drawdown

The largest peak-to-trough decline in a trader's equity. A 30% max drawdown means the trader's account dropped 30% from its highest point before recovering.

- **< 10%**: Very conservative
- **10-25%**: Moderate risk
- **25-50%**: Aggressive
- **> 50%**: Very high risk

## Sharpe Ratio

Measures risk-adjusted return — how much return per unit of volatility.

\`Sharpe = (Average Return - Risk-Free Rate) / Standard Deviation of Returns\`

- **< 0.5**: Poor risk-adjusted returns
- **0.5-1.0**: Acceptable
- **1.0-2.0**: Good
- **> 2.0**: Excellent

Arena computes Sharpe from daily returns over the relevant period.

## Win Rate

The percentage of profitable trading days. A 60% win rate means the trader was profitable on 6 out of 10 days.

- **> 65%**: Consistently profitable
- **50-65%**: Average (can still be very profitable with good risk/reward)
- **< 50%**: Loses more often than wins (may still profit if winners are larger)

## Using Metrics Together

A trader with 200% ROI but 80% max drawdown is far riskier than one with 50% ROI and 15% drawdown. Always look at the full picture: ROI, drawdown, Sharpe, and win rate together tell the real story.
    `.trim(),
  },
  {
    slug: 'getting-started',
    title: 'Getting Started with Arena',
    excerpt:
      'A quick guide to navigating Arena, finding top traders, following them, and going Pro.',
    content: `
# Getting Started with Arena

Welcome to Arena! Here is how to get the most out of the platform.

## 1. Browse Rankings

The homepage shows the **global leaderboard** — all 34,000+ traders ranked by Arena Score. Use the period selector to switch between 7D, 30D, and 90D views.

## 2. Filter by Exchange

Click on any exchange name in the rankings to see only traders from that platform. You can also use the exchange filter dropdown to narrow results.

## 3. View Trader Profiles

Click on any trader to see their detailed profile including:
- Performance chart over time
- Risk metrics (drawdown, Sharpe, win rate)
- Trading style analysis
- Arena Score breakdown

## 4. Follow Traders

Create a free account and follow traders to:
- Build a personalized watchlist
- Track their performance over time
- Get notified of significant changes

## 5. Go Pro

Arena Pro unlocks:
- **Advanced analytics**: Deeper risk metrics and performance comparisons
- **Alerts**: Get notified when followed traders have unusual activity
- **Trader comparison**: Compare up to 4 traders side by side
- **Export data**: Download rankings and performance data

Visit the pricing page to learn more about Pro membership.

## 6. Join the Community

Arena has a built-in social layer. Join groups, post trade ideas, and discuss strategies with other traders.
    `.trim(),
  },
]

export function getArticleBySlug(slug: string): Article | undefined {
  return ARTICLES.find(a => a.slug === slug)
}
