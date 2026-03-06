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
  toTimeframe: Timeframe,
): CandlestickData[] {
  const fromSec = TIMEFRAME_SECONDS[fromTimeframe]
  const toSec = TIMEFRAME_SECONDS[toTimeframe]

  if (toSec < fromSec) {
    throw new Error(`Cannot convert from ${fromTimeframe} to smaller timeframe ${toTimeframe}`)
  }

  const result =
    toSec === fromSec
      ? candles
      : batchCandles(candles, fromSec, toSec)

  return result.map(([time, open, high, low, close, volume]: [number, number, number, number, number, number]) => ({
    time,
    open,
    high,
    low,
    close,
    volume,
  }))
}

/**
 * Standardize raw OHLCV data from any exchange (ccxt format) into CandlestickData[].
 */
export function standardizeCandles(
  rawCandles: [number, number, number, number, number, number][],
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
