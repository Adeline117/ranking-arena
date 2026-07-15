import { syncExchangePortfolio } from '../exchange-sync'

const base = {
  portfolioId: 'portfolio-1',
  apiKeyEncrypted: 'not-read',
  apiSecretEncrypted: 'not-read',
  userId: 'user-1',
}

describe('syncExchangePortfolio guardrails', () => {
  it('refuses an unsupported exchange before attempting to decrypt credentials', async () => {
    await expect(syncExchangePortfolio({ ...base, exchange: 'unknown-exchange' })).resolves.toEqual(
      {
        ok: false,
        reason: 'unsupported',
      }
    )
  })

  it('does not attempt geo-blocked exchange sync without a configured proxy', async () => {
    const oldUrl = process.env.PORTFOLIO_SYNC_PROXY_URL
    const oldKey = process.env.PORTFOLIO_SYNC_PROXY_KEY
    const oldVpsUrl = process.env.VPS_PROXY_SG
    const oldVpsKey = process.env.VPS_PROXY_KEY
    delete process.env.PORTFOLIO_SYNC_PROXY_URL
    delete process.env.PORTFOLIO_SYNC_PROXY_KEY
    delete process.env.VPS_PROXY_SG
    delete process.env.VPS_PROXY_KEY
    try {
      await expect(syncExchangePortfolio({ ...base, exchange: 'binance' })).resolves.toEqual({
        ok: false,
        reason: 'geo_unavailable',
      })
    } finally {
      if (oldUrl === undefined) delete process.env.PORTFOLIO_SYNC_PROXY_URL
      else process.env.PORTFOLIO_SYNC_PROXY_URL = oldUrl
      if (oldKey === undefined) delete process.env.PORTFOLIO_SYNC_PROXY_KEY
      else process.env.PORTFOLIO_SYNC_PROXY_KEY = oldKey
      if (oldVpsUrl === undefined) delete process.env.VPS_PROXY_SG
      else process.env.VPS_PROXY_SG = oldVpsUrl
      if (oldVpsKey === undefined) delete process.env.VPS_PROXY_KEY
      else process.env.VPS_PROXY_KEY = oldVpsKey
    }
  })

  it('requires a passphrase before reading credentials for passphrase exchanges', async () => {
    await expect(syncExchangePortfolio({ ...base, exchange: 'bitget' })).resolves.toEqual({
      ok: false,
      reason: 'passphrase_required',
    })
  })
})
