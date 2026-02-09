/**
 * Scoring 模块导出
 */
export {
  calculateArenaScoreV3,
  calculateMultiWindowScore,
  buildPeerContext,
  percentileRank,
  detectCompleteness,
} from './arena-score-v3'

export type {
  ArenaScoreV3Input,
  ArenaScoreV3Result,
  PercentileContext,
  MultiWindowInput,
  DataCompleteness,
} from './arena-score-v3'
