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
  {
    slug: 'top-traders-by-exchange',
    title: 'Top Traders by Exchange: Who Leads Each Platform?',
    excerpt: 'A breakdown of trading performance across Binance, Bybit, Hyperliquid, and 25+ other exchanges.',
    content: `
# Top Traders by Exchange

Arena tracks **28+ exchanges** spanning centralized (CEX) and decentralized (DEX) platforms. Each exchange has its own leaderboard, ranked by Arena Score.

## CEX Leaders
- **Binance Futures**: The largest exchange by volume. Top traders here tend to have high PnL but moderate ROI due to competition.
- **Bybit**: Known for copy-trading features. Leaders often have consistent win rates above 60%.
- **OKX Futures**: Strong performers in derivatives. The OKX leaderboard includes verified traders with transparent track records.

## DEX Leaders
- **Hyperliquid**: The fastest-growing DEX. Top traders leverage on-chain transparency — every trade is verifiable.
- **GMX**: Built on Arbitrum. Leaders here focus on leveraged perpetual positions.
- **dYdX**: The original DeFi perpetuals exchange. Top traders benefit from deep liquidity.

## How to Compare
Use Arena's **Platform Stats** (/api/rankings/platform-stats) to see average ROI, median score, and trader count per exchange. This helps you identify which platforms produce the most consistent performers.

## Key Insight
CEX traders typically show higher PnL (more capital), while DEX traders show higher ROI percentages (more leverage). Arena Score normalizes these differences so you can compare fairly across platforms.
`,
  },
  {
    slug: 'what-is-copy-trading',
    title: 'What is Copy Trading? A Beginner\'s Guide',
    excerpt: 'Learn how copy trading works, its benefits and risks, and how Arena helps you find the best traders to follow.',
    content: `
# What is Copy Trading?

Copy trading lets you automatically replicate the trades of experienced traders. When they buy, you buy. When they sell, you sell. It's like having a professional manage your portfolio.

## How It Works
1. **Browse rankings** on Arena to find top-performing traders
2. **Analyze their profile** — check ROI, drawdown, win rate, and trading style
3. **Follow them** on their exchange's copy-trading platform (Binance, Bybit, OKX, etc.)
4. **Set your allocation** — decide how much capital to allocate

## Benefits
- **No experience needed**: Let proven traders make decisions
- **Diversification**: Follow multiple traders across different styles
- **Transparency**: See real-time performance before committing

## Risks
- **Past performance ≠ future results**: Even top traders have losing streaks
- **Drawdown risk**: A 50% drawdown means you need 100% gain to recover
- **Slippage**: Your fills may differ from the trader you're copying

## How Arena Helps
Arena's **Arena Score** combines ROI and PnL into a single risk-adjusted metric. Use filters like "Low Risk" (low drawdown) or "Consistent" (high win rate) to find traders matching your risk tolerance.

> **Pro tip**: Don't put all your capital with one trader. Spread across 3-5 traders with different trading styles for better risk management.
`,
  },
  {
    slug: 'trading-styles-explained',
    title: 'Trading Styles Explained: Scalper, Swing, Trend, Position',
    excerpt: 'Understand the four main trading styles and how Arena classifies traders automatically.',
    content: `
# Trading Styles Explained

Arena automatically classifies traders into four styles based on their behavior:

## Scalper (< 4 hours avg hold)
- Opens and closes positions within hours or minutes
- High trade frequency, small gains per trade
- Requires constant market attention
- **Best for**: Volatile markets, high-frequency strategies

## Swing Trader (4 hours - 7 days avg hold)
- Holds positions for days, capturing medium-term moves
- Moderate trade frequency
- Balances analysis time with active management
- **Best for**: Traders who can't watch markets 24/7

## Trend Follower (7 - 30 days avg hold)
- Rides major market trends for weeks
- Lower trade frequency, larger gains per trade
- Requires patience and conviction
- **Best for**: Trending markets, lower time commitment

## Position Trader (> 30 days avg hold)
- Long-term holding with strategic entry/exit
- Minimal daily management
- Highest risk per trade but potential for largest gains
- **Best for**: Long-term conviction plays

## How Arena Classifies
Arena calculates **average holding hours** from a trader's position history. Combined with trade frequency and win rate patterns, it assigns a style with a **confidence score** (0-100%). You can filter by style on any ranking page.
`,
  },
  {
    slug: 'how-to-read-equity-curves',
    title: 'How to Read Equity Curves and Drawdown Charts',
    excerpt: 'Learn to interpret the visual charts on trader profiles — equity curves, drawdown depth, and daily returns.',
    content: `
# How to Read Equity Curves

Every trader profile on Arena shows several charts. Here's how to interpret them:

## Equity Curve
The main chart showing cumulative ROI over time. A healthy equity curve slopes **upward and to the right** with minimal dips.

**What to look for:**
- **Steady upward slope**: Consistent performance (good)
- **Sharp spikes**: Concentrated gains from few trades (risky)
- **Flat periods**: Trader inactive or in drawdown
- **Vertical drops**: Significant losses

## Drawdown Chart (Underwater Chart)
Shows how far below the peak the portfolio has fallen at any point. Always negative or zero.

**Key metrics:**
- **Max Drawdown**: The deepest the portfolio fell from its peak
- **Recovery time**: How long to recover from the worst drawdown
- **Frequency**: How often drawdowns occur

**Rule of thumb**: A max drawdown of 20% means the trader lost 20% from their best point. They need 25% gain to recover.

## Daily Returns Distribution
A histogram showing how many days had positive vs negative returns.

**What to look for:**
- **Symmetry**: Bell-shaped = consistent. Skewed right = occasional big wins. Skewed left = occasional big losses.
- **Fat tails**: Many extreme days = high volatility
- **Narrow distribution**: Most days near 0% = low volatility, consistent

## Pro Tips
1. Compare 7D, 30D, and 90D curves — short-term performance can differ dramatically from long-term
2. A trader with lower ROI but smaller drawdown may be better for copy-trading (less emotional stress)
3. Check win rate + avg hold time together — a 90% win rate with 1-minute holds might be a bot
`,
  },
  {
    slug: 'arena-pro-features',
    title: 'Arena Pro: What You Get with a Subscription',
    excerpt: 'Detailed overview of Pro features including advanced analytics, trader comparison, rank alerts, and more.',
    content: `
# Arena Pro Features

Arena Pro unlocks powerful tools for serious traders and analysts. Here's what's included:

## Advanced Analytics
- **Score Breakdown**: See exactly how a trader's Arena Score is calculated — Return Score, PnL Score, confidence multiplier, and platform trust weight
- **Risk Metrics**: Sharpe ratio, Sortino ratio, Calmar ratio, and profit factor for every trader
- **Market Correlation**: Beta to BTC/ETH and alpha generation metrics

## Trader Comparison
- Compare up to 5 traders side-by-side
- Overlay equity curves on a single chart
- Correlation analysis between traders
- Style compatibility matrix

## Rank Alerts
- Get notified when a followed trader enters or exits the top 100
- Custom threshold alerts (e.g., "Alert me if ROI drops below 50%")
- Delivered via in-app notifications and email

## Advanced Filters
- Filter by trading style (Scalper, Swing, Trend, Position)
- Minimum score, ROI, PnL thresholds
- Maximum drawdown filter
- Win rate range filter

## Pro Badge
- Purple Pro badge on your profile
- Priority in community features
- Access to Pro-only groups

## Pricing
- **Monthly**: $4.99/month
- **Yearly**: $29.99/year (save 50%)
- **Lifetime**: $49.99 one-time payment

[Upgrade to Pro →](/pricing)
`,
  },
]

export function getArticleBySlug(slug: string): Article | undefined {
  return ARTICLES.find(a => a.slug === slug)
}
