/**
 * 风险预警系统类型定义
 */

// ============================================
// 告警类型
// ============================================

export type AlertType =
  | 'DRAWDOWN_WARNING'      // 回撤超过阈值
  | 'DRAWDOWN_SPIKE'        // 回撤急剧加深
  | 'STYLE_CHANGE'          // 交易风格突变
  | 'POSITION_SPIKE'        // 仓位异常放大
  | 'WIN_RATE_DROP'         // 胜率骤降
  | 'FOLLOWER_EXODUS'       // 大量跟单者撤离
  | 'PROFIT_TARGET_HIT'     // 达到止盈目标
  | 'STOP_LOSS_HIT'         // 达到止损目标

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

// ============================================
// 告警配置
// ============================================

export interface UserAlertConfig {
  id: string
  user_id: string
  trader_id: string
  source: string
  
  // 告警阈值
  drawdown_threshold: number        // 回撤告警阈值（%）
  drawdown_spike_threshold: number  // 回撤急剧加深阈值
  win_rate_drop_threshold: number   // 胜率下降告警阈值
  profit_target: number | null      // 止盈目标（%）
  stop_loss: number | null          // 止损目标（%）
  
  // 通知方式
  notify_in_app: boolean
  notify_email: boolean
  notify_push: boolean
  
  // 启用的告警类型
  alert_types: AlertType[]
  
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CreateAlertConfigInput {
  trader_id: string
  source: string
  drawdown_threshold?: number
  drawdown_spike_threshold?: number
  win_rate_drop_threshold?: number
  profit_target?: number
  stop_loss?: number
  notify_in_app?: boolean
  notify_email?: boolean
  notify_push?: boolean
  alert_types?: AlertType[]
}

export interface UpdateAlertConfigInput {
  drawdown_threshold?: number
  drawdown_spike_threshold?: number
  win_rate_drop_threshold?: number
  profit_target?: number | null
  stop_loss?: number | null
  notify_in_app?: boolean
  notify_email?: boolean
  notify_push?: boolean
  alert_types?: AlertType[]
  enabled?: boolean
}

// ============================================
// 告警记录
// ============================================

export interface TraderAlert {
  id: string
  user_id: string
  trader_id: string
  source: string
  type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  data: AlertData
  read: boolean
  acknowledged_at: string | null
  created_at: string
}

export type AlertData = 
  | DrawdownAlertData
  | WinRateAlertData
  | FollowerAlertData
  | TargetAlertData
  | Record<string, unknown>

export interface DrawdownAlertData {
  current_drawdown: number
  previous_drawdown: number
  threshold: number
  change_24h: number
}

export interface WinRateAlertData {
  current_win_rate: number
  previous_win_rate: number
  threshold: number
  change: number
}

export interface FollowerAlertData {
  current_followers: number
  previous_followers: number
  change_percent: number
}

export interface TargetAlertData {
  current_roi: number
  target: number
  type: 'profit' | 'loss'
}

// ============================================
// 每日快照
// ============================================

export interface TraderDailySnapshot {
  id: string
  trader_id: string
  source: string
  roi: number | null
  pnl: number | null
  max_drawdown: number | null
  win_rate: number | null
  followers: number | null
  trades_count: number | null
  snapshot_date: string
  created_at: string
}

// ============================================
// 告警配置常量
// ============================================

export const DEFAULT_ALERT_CONFIG = {
  drawdown_threshold: 10,
  drawdown_spike_threshold: 5,
  win_rate_drop_threshold: 10,
  notify_in_app: true,
  notify_email: false,
  notify_push: false,
  alert_types: ['DRAWDOWN_WARNING', 'DRAWDOWN_SPIKE', 'WIN_RATE_DROP'] as AlertType[],
}

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  DRAWDOWN_WARNING: '回撤预警',
  DRAWDOWN_SPIKE: '回撤急剧加深',
  STYLE_CHANGE: '交易风格突变',
  POSITION_SPIKE: '仓位异常',
  WIN_RATE_DROP: '胜率下降',
  FOLLOWER_EXODUS: '跟单者撤离',
  PROFIT_TARGET_HIT: '达到止盈目标',
  STOP_LOSS_HIT: '达到止损目标',
}

export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  CRITICAL: '紧急',
}

export const ALERT_SEVERITY_COLORS: Record<AlertSeverity, string> = {
  LOW: '#6B7280',
  MEDIUM: '#F59E0B',
  HIGH: '#EF4444',
  CRITICAL: '#DC2626',
}
