// All 38 cron jobs from vercel.json mapped to BullMQ repeatable jobs
// Each job calls the corresponding API endpoint via HTTP

const JOBS = [
  // === Core ===
  { name: 'compute-leaderboard', path: '/api/cron/compute-leaderboard', cron: '0 * * * *' },
  { name: 'fetch-followed-traders', path: '/api/cron/fetch-followed-traders', cron: '0 * * * *' },
  { name: 'check-data-freshness', path: '/api/cron/check-data-freshness', cron: '0 */3 * * *' },
  { name: 'subscription-expiry', path: '/api/cron/subscription-expiry', cron: '0 0 * * *' },
  { name: 'cleanup-deleted-accounts', path: '/api/cron/cleanup-deleted-accounts', cron: '0 3 * * *' },

  // === Batch & Jobs ===
  { name: 'batch-5min', path: '/api/cron/batch-5min', cron: '*/5 * * * *' },
  { name: 'run-jobs', path: '/api/cron/run-jobs?max=20', cron: '*/2 * * * *' },

  // === Fetch Details (tiered) ===
  { name: 'fetch-details-hot', path: '/api/cron/fetch-details?tier=hot&concurrency=50&limit=100', cron: '*/15 * * * *' },
  { name: 'fetch-details-active', path: '/api/cron/fetch-details?tier=active&concurrency=40&limit=200', cron: '15 * * * *' },
  { name: 'fetch-details-normal', path: '/api/cron/fetch-details?tier=normal&concurrency=30&limit=300', cron: '30 */4 * * *' },
  { name: 'fetch-details-dormant', path: '/api/cron/fetch-details?tier=dormant&concurrency=20&limit=500', cron: '30 3 * * *' },

  // === Tiers & Discovery ===
  { name: 'calculate-tiers', path: '/api/cron/calculate-tiers', cron: '*/15 * * * *' },
  { name: 'discover-traders', path: '/api/cron/discover-traders', cron: '56 */4 * * *' },
  { name: 'discover-rankings', path: '/api/cron/discover-rankings', cron: '58 */4 * * *' },

  // === Market Data ===
  { name: 'fetch-market-data-prices', path: '/api/cron/fetch-market-data?type=prices', cron: '0 */1 * * *' },
  { name: 'fetch-funding-rates', path: '/api/cron/fetch-funding-rates', cron: '0 */4 * * *' },
  { name: 'fetch-open-interest', path: '/api/cron/fetch-open-interest', cron: '0 * * * *' },
  { name: 'calculate-advanced-metrics', path: '/api/cron/calculate-advanced-metrics', cron: '30 */4 * * *' },
  { name: 'aggregate-daily-snapshots', path: '/api/cron/aggregate-daily-snapshots', cron: '5 0 * * *' },

  // === Scrape ===
  { name: 'scrape-proxy-all', path: '/api/scrape/proxy?period=all', cron: '0 2,6,10,14,18,22 * * *' },

  // === Fetch Traders (per platform) ===
  { name: 'fetch-traders-binance-futures', path: '/api/cron/fetch-traders/binance_futures', cron: '55 */3 * * *' },
  { name: 'fetch-traders-binance-spot', path: '/api/cron/fetch-traders/binance_spot', cron: '56 */3 * * *' },
  { name: 'fetch-traders-bybit', path: '/api/cron/fetch-traders/bybit', cron: '57 */3 * * *' },
  { name: 'fetch-traders-bitget-futures', path: '/api/cron/fetch-traders/bitget_futures', cron: '58 */3 * * *' },
  { name: 'fetch-traders-okx-futures', path: '/api/cron/fetch-traders/okx_futures', cron: '59 */3 * * *' },
  { name: 'fetch-traders-mexc', path: '/api/cron/fetch-traders/mexc', cron: '0 */4 * * *' },
  { name: 'fetch-traders-kucoin', path: '/api/cron/fetch-traders/kucoin', cron: '3 */4 * * *' },
  { name: 'fetch-traders-okx-web3', path: '/api/cron/fetch-traders/okx_web3', cron: '6 */4 * * *' },
  { name: 'fetch-traders-hyperliquid', path: '/api/cron/fetch-traders/hyperliquid', cron: '9 */4 * * *' },
  { name: 'fetch-traders-gmx', path: '/api/cron/fetch-traders/gmx', cron: '12 */4 * * *' },
  { name: 'fetch-traders-jupiter-perps', path: '/api/cron/fetch-traders/jupiter_perps', cron: '15 */4 * * *' },
  { name: 'fetch-traders-aevo', path: '/api/cron/fetch-traders/aevo', cron: '18 */4 * * *' },
  { name: 'fetch-traders-coinex', path: '/api/cron/fetch-traders/coinex', cron: '21 */6 * * *' },
  { name: 'fetch-traders-bitget-spot', path: '/api/cron/fetch-traders/bitget_spot', cron: '24 */6 * * *' },
  { name: 'fetch-traders-xt', path: '/api/cron/fetch-traders/xt', cron: '27 */6 * * *' },
  { name: 'fetch-traders-vertex', path: '/api/cron/fetch-traders/vertex', cron: '30 */6 * * *' },

  // === Enrichment ===
  { name: 'enrich-binance-futures', path: '/api/cron/enrich?platform=binance_futures&period=90D&limit=100', cron: '10 */4 * * *' },
  { name: 'enrich-bybit', path: '/api/cron/enrich?platform=bybit&period=90D&limit=100', cron: '20 */4 * * *' },

  // === Alerts ===
  { name: 'check-trader-alerts', path: '/api/cron/check-trader-alerts', cron: '0 */6 * * *' },
];

module.exports = JOBS;
