import { batchCandles } from 'candlestick-convert'

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export interface CandlestickData {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Timeframe duration in seconds */
const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

/**
 * Convert OHLCV array data from one timeframe to another.
 * Each candle is [timestamp, open, high, low, close, volume] (ccxt format).
 */
export function convertTimeframe(
  candles: [number, number, number, number, number, number][],
  fromTimeframe: Timeframe,
  toTimeframe: Timeframe
): CandlestickData[] {
  const fromSec = TIMEFRAME_SECONDS[fromTimeframe]
  const toSec = TIMEFRAME_SECONDS[toTimeframe]

  if (toSec < fromSec) {
    throw new Error(`Cannot convert from ${fromTimeframe} to smaller timeframe ${toTimeframe}`)
  }

  let result: [number, number, number, number, number, number][]
  if (toSec === fromSec) {
    result = candles
  } else {
    // ccxt 时间戳是**毫秒**，但 batchCandles 的 period 参数是**秒**，直接传会
    // 让分桶按秒对齐、把毫秒时间戳错分到不同桶 → 聚合出错（丢 candle、OHLC/volume
    // 错，2026-07-03 测试发现）。先把时间戳 ms→s 喂给 batchCandles，输出再 s→ms 还原。
    const inSec = candles.map(
      ([t, o, h, l, c, v]) =>
        [Math.floor(t / 1000), o, h, l, c, v] as [number, number, number, number, number, number]
    )
    result = batchCandles(inSec, fromSec, toSec).map(
      ([t, o, h, l, c, v]: [number, number, number, number, number, number]) =>
        [t * 1000, o, h, l, c, v] as [number, number, number, number, number, number]
    )
  }

  return result.map(
    ([time, open, high, low, close, volume]: [number, number, number, number, number, number]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    })
  )
}

/**
 * Standardize raw OHLCV data from any exchange (ccxt format) into CandlestickData[].
 */
export function standardizeCandles(
  rawCandles: [number, number, number, number, number, number][]
): CandlestickData[] {
  return rawCandles.map(([time, open, high, low, close, volume]) => ({
    time,
    open,
    high,
    low,
    close,
    volume,
  }))
}

export { TIMEFRAME_SECONDS }
