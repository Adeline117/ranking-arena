import { MexcConnector } from '../connectors/mexc/index.ts'
import { CoinExConnector } from '../connectors/coinex/index.ts'
import { BitgetFuturesConnector } from '../connectors/bitget/index.ts'
import { BybitConnector } from '../connectors/bybit/index.ts'

async function main() {
  // MEXC
  console.log('═══ MEXC ═══')
  try {
    const mexc = new MexcConnector()
    const r = await mexc.discoverLeaderboard('90d', 3)
    console.log('OK:', r.ok, r.ok ? r.data.length + ' traders' : r.error)
    if (r.ok && r.data[0]) console.log('Metrics:', JSON.stringify(r.data[0].metrics))
  } catch (e: any) { console.log('Error:', e.message) }

  // CoinEx
  console.log('\n═══ CoinEx ═══')
  try {
    const coinex = new CoinExConnector()
    const r = await coinex.discoverLeaderboard('90d', 3)
    console.log('OK:', r.ok, r.ok ? r.data.length + ' traders' : r.error)
    if (r.ok && r.data[0]) console.log('Metrics:', JSON.stringify(r.data[0].metrics))
  } catch (e: any) { console.log('Error:', e.message) }

  // Bitget
  console.log('\n═══ Bitget ═══')
  try {
    const bitget = new BitgetFuturesConnector()
    const r = await bitget.discoverLeaderboard('90d', 3)
    console.log('OK:', r.ok, r.ok ? r.data.length + ' traders' : r.error)
    if (r.ok && r.data[0]) console.log('Metrics:', JSON.stringify(r.data[0].metrics))
  } catch (e: any) { console.log('Error:', e.message) }

  // Bybit
  console.log('\n═══ Bybit ═══')
  try {
    const bybit = new BybitConnector()
    const r = await bybit.discoverLeaderboard('90d', 3)
    console.log('OK:', r.ok, r.ok ? r.data.length + ' traders' : r.error)
    if (r.ok && r.data[0]) console.log('Metrics:', JSON.stringify(r.data[0].metrics))
  } catch (e: any) { console.log('Error:', e.message) }
}
main()
