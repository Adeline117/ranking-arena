/**
 * 风险预警系统
 * 
 * 支持的预警类型：
 * - drawdown: 回撤预警 - 当交易员回撤超过阈值时触发
 * - rank_drop: 排名下降预警 - 当交易员排名下降超过阈值时触发
 * - win_rate_drop: 胜率下滑预警 - 当交易员胜率低于阈值时触发
 * - roi_change: ROI 大幅变动预警 - 当 ROI 变动超过阈值时触发
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

// ============================================
// 类型定义
// ============================================

export type AlertType = 'drawdown' | 'rank_drop' | 'win_rate_drop' | 'roi_change'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface RiskAlert {
  id: string
  userId: string
  traderId: string
  traderHandle: string
  alertType: AlertType
  severity: AlertSeverity
  threshold: number
  currentValue: number
  previousValue?: number
  message: string
  createdAt: Date
  isRead: boolean
}

export interface AlertConfig {
  id: string
  userId: string
  traderId: string
  traderHandle: string
  alertType: AlertType
  threshold: number
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderSnapshot {
  source: string
  sourceTraderid: string
  handle?: string
  roi: number
  rank?: number
  winRate?: number
  maxDrawdown?: number
  capturedAt: Date
}

// ============================================
// 默认阈值配置
// ============================================

export const DEFAULT_THRESHOLDS = {
  drawdown: {
    warning: 15,    // 15% 回撤触发警告
    critical: 25,   // 25% 回撤触发严重警告
  },
  rank_drop: {
    warning: 10,    // 排名下降 10 位触发警告
    critical: 20,   // 排名下降 20 位触发严重警告
  },
  win_rate_drop: {
    warning: 45,    // 胜率低于 45% 触发警告
    critical: 35,   // 胜率低于 35% 触发严重警告
  },
  roi_change: {
    warning: -10,   // ROI 下降 10% 触发警告
    critical: -20,  // ROI 下降 20% 触发严重警告
  },
}

// ============================================
// 预警消息模板
// ============================================

const ALERT_MESSAGES = {
  drawdown: {
    zh: (handle: string, value: number) => 
      `${handle} 当前回撤 ${Math.abs(value).toFixed(1)}%，请注意风险`,
    en: (handle: string, value: number) => 
      `${handle} current drawdown ${Math.abs(value).toFixed(1)}%, please pay attention to the risk`,
  },
  rank_drop: {
    zh: (handle: string, value: number, prev: number) => 
      `${handle} 排名从 ${prev} 下降到 ${value}，下降了 ${value - prev} 位`,
    en: (handle: string, value: number, prev: number) => 
      `${handle} rank dropped from ${prev} to ${value}, down ${value - prev} positions`,
  },
  win_rate_drop: {
    zh: (handle: string, value: number) => 
      `${handle} 当前胜率 ${value.toFixed(1)}%，低于预警阈值`,
    en: (handle: string, value: number) => 
      `${handle} current win rate ${value.toFixed(1)}%, below alert threshold`,
  },
  roi_change: {
    zh: (handle: string, value: number, prev: number) => 
      `${handle} ROI 从 ${prev.toFixed(1)}% 变为 ${value.toFixed(1)}%`,
    en: (handle: string, value: number, prev: number) => 
      `${handle} ROI changed from ${prev.toFixed(1)}% to ${value.toFixed(1)}%`,
  },
}

// ============================================
// 工具函数
// ============================================

function getSeverity(
  alertType: AlertType,
  currentValue: number,
  _threshold: number
): AlertSeverity {
  const defaults = DEFAULT_THRESHOLDS[alertType]
  
  switch (alertType) {
    case 'drawdown':
      if (Math.abs(currentValue) >= defaults.critical) return 'critical'
      if (Math.abs(currentValue) >= defaults.warning) return 'warning'
      return 'info'
    case 'rank_drop':
      if (currentValue >= defaults.critical) return 'critical'
      if (currentValue >= defaults.warning) return 'warning'
      return 'info'
    case 'win_rate_drop':
      if (currentValue <= defaults.critical) return 'critical'
      if (currentValue <= defaults.warning) return 'warning'
      return 'info'
    case 'roi_change':
      if (currentValue <= defaults.critical) return 'critical'
      if (currentValue <= defaults.warning) return 'warning'
      return 'info'
    default:
      return 'info'
  }
}

function formatAlertMessage(
  alertType: AlertType,
  handle: string,
  currentValue: number,
  previousValue: number,
  language: 'zh' | 'en' = 'zh'
): string {
  const templates = ALERT_MESSAGES[alertType]
  const template = templates[language] as (handle: string, value: number, prev?: number) => string
  
  switch (alertType) {
    case 'drawdown':
    case 'win_rate_drop':
      return template(handle, currentValue)
    case 'rank_drop':
    case 'roi_change':
      return template(handle, currentValue, previousValue)
    default:
      return `${handle} 触发预警`
  }
}

// ============================================
// 风险预警服务类
// ============================================

export class RiskAlertService {

  private supabase: SupabaseClient

  constructor() {
    this.supabase = getSupabaseAdmin()
  }

  /**
   * 检查回撤预警
   */
  async checkDrawdownAlert(
    userId: string,
    traderId: string,
    traderHandle: string,
    currentDrawdown: number,
    threshold: number
  ): Promise<RiskAlert | null> {
    const absDrawdown = Math.abs(currentDrawdown)
    
    if (absDrawdown < threshold) {
      return null
    }

    const severity = getSeverity('drawdown', currentDrawdown, threshold)
    const message = formatAlertMessage('drawdown', traderHandle, currentDrawdown, 0)

    const alert: Omit<RiskAlert, 'id' | 'createdAt'> = {
      userId,
      traderId,
      traderHandle,
      alertType: 'drawdown',
      severity,
      threshold,
      currentValue: currentDrawdown,
      previousValue: 0,
      message,
      isRead: false,
    }

    return this.createAlert(alert)
  }

  /**
   * 检查排名下降预警
   */
  async checkRankDropAlert(
    userId: string,
    traderId: string,
    traderHandle: string,
    currentRank: number,
    previousRank: number,
    threshold: number
  ): Promise<RiskAlert | null> {
    const rankDrop = currentRank - previousRank
    
    if (rankDrop < threshold) {
      return null
    }

    const severity = getSeverity('rank_drop', rankDrop, threshold)
    const message = formatAlertMessage('rank_drop', traderHandle, currentRank, previousRank)

    const alert: Omit<RiskAlert, 'id' | 'createdAt'> = {
      userId,
      traderId,
      traderHandle,
      alertType: 'rank_drop',
      severity,
      threshold,
      currentValue: currentRank,
      previousValue: previousRank,
      message,
      isRead: false,
    }

    return this.createAlert(alert)
  }

  /**
   * 检查胜率下滑预警
   */
  async checkWinRateAlert(
    userId: string,
    traderId: string,
    traderHandle: string,
    currentWinRate: number,
    threshold: number
  ): Promise<RiskAlert | null> {
    if (currentWinRate > threshold) {
      return null
    }

    const severity = getSeverity('win_rate_drop', currentWinRate, threshold)
    const message = formatAlertMessage('win_rate_drop', traderHandle, currentWinRate, 0)

    const alert: Omit<RiskAlert, 'id' | 'createdAt'> = {
      userId,
      traderId,
      traderHandle,
      alertType: 'win_rate_drop',
      severity,
      threshold,
      currentValue: currentWinRate,
      previousValue: 0,
      message,
      isRead: false,
    }

    return this.createAlert(alert)
  }

  /**
   * 创建预警记录
   */
  private async createAlert(
    alert: Omit<RiskAlert, 'id' | 'createdAt'>
  ): Promise<RiskAlert> {
    const { data, error } = await this.supabase
      .from('risk_alerts')
      .insert({
        user_id: alert.userId,
        trader_id: alert.traderId,
        trader_handle: alert.traderHandle,
        alert_type: alert.alertType,
        severity: alert.severity,
        threshold: alert.threshold,
        current_value: alert.currentValue,
        previous_value: alert.previousValue,
        message: alert.message,
        is_read: alert.isRead,
      })
      .select()
      .single()

    if (error) {
      logger.error('[RiskAlert] 创建预警失败:', error)
      throw error
    }

    return {
      id: data.id,
      userId: data.user_id,
      traderId: data.trader_id,
      traderHandle: data.trader_handle,
      alertType: data.alert_type,
      severity: data.severity,
      threshold: data.threshold,
      currentValue: data.current_value,
      previousValue: data.previous_value,
      message: data.message,
      createdAt: new Date(data.created_at),
      isRead: data.is_read,
    }
  }

  /**
   * 获取用户的预警配置
   */
  async getUserAlertConfigs(userId: string): Promise<AlertConfig[]> {
    const { data, error } = await this.supabase
      .from('alert_configs')
      .select('id, user_id, trader_id, trader_handle, alert_type, threshold, enabled, created_at, updated_at')
      .eq('user_id', userId)
      .eq('enabled', true)

    if (error) {
      logger.error('[RiskAlert] 获取预警配置失败:', error)
      throw error
    }

     
    type ConfigRow = { id: string; user_id: string; trader_id: string; trader_handle: string; alert_type: AlertType; threshold: number; enabled: boolean; created_at: string; updated_at: string }
    return (data || []).map((row: ConfigRow) => ({
      id: row.id,
      userId: row.user_id,
      traderId: row.trader_id,
      traderHandle: row.trader_handle,
      alertType: row.alert_type,
      threshold: row.threshold,
      enabled: row.enabled,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }))
  }

  /**
   * 创建或更新预警配置
   */
  async upsertAlertConfig(config: Omit<AlertConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<AlertConfig> {
    const { data, error } = await this.supabase
      .from('alert_configs')
      .upsert({
        user_id: config.userId,
        trader_id: config.traderId,
        trader_handle: config.traderHandle,
        alert_type: config.alertType,
        threshold: config.threshold,
        enabled: config.enabled,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,trader_id,alert_type',
      })
      .select()
      .single()

    if (error) {
      logger.error('[RiskAlert] 更新预警配置失败:', error)
      throw error
    }

    return {
      id: data.id,
      userId: data.user_id,
      traderId: data.trader_id,
      traderHandle: data.trader_handle,
      alertType: data.alert_type,
      threshold: data.threshold,
      enabled: data.enabled,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
    }
  }

  /**
   * 删除预警配置
   */
  async deleteAlertConfig(userId: string, traderId: string, alertType: AlertType): Promise<void> {
    const { error } = await this.supabase
      .from('alert_configs')
      .delete()
      .eq('user_id', userId)
      .eq('trader_id', traderId)
      .eq('alert_type', alertType)

    if (error) {
      logger.error('[RiskAlert] 删除预警配置失败:', error)
      throw error
    }
  }

  /**
   * 获取用户未读预警
   */
  async getUnreadAlerts(userId: string, limit: number = 20): Promise<RiskAlert[]> {
    const { data, error } = await this.supabase
      .from('risk_alerts')
      .select('id, user_id, trader_id, trader_handle, alert_type, severity, threshold, current_value, previous_value, message, created_at, is_read')
      .eq('user_id', userId)
      .eq('is_read', false)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      logger.error('[RiskAlert] 获取预警失败:', error)
      throw error
    }

     
    type AlertRow = { id: string; user_id: string; trader_id: string; trader_handle: string; alert_type: AlertType; severity: AlertSeverity; threshold: number; current_value: number; previous_value?: number; message: string; created_at: string; is_read: boolean }
    return (data || []).map((row: AlertRow) => ({
      id: row.id,
      userId: row.user_id,
      traderId: row.trader_id,
      traderHandle: row.trader_handle,
      alertType: row.alert_type,
      severity: row.severity,
      threshold: row.threshold,
      currentValue: row.current_value,
      previousValue: row.previous_value,
      message: row.message,
      createdAt: new Date(row.created_at),
      isRead: row.is_read,
    }))
  }

  /**
   * 标记预警为已读
   */
  async markAlertAsRead(alertId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('risk_alerts')
      .update({ is_read: true })
      .eq('id', alertId)
      .eq('user_id', userId)

    if (error) {
      logger.error('[RiskAlert] 标记预警失败:', error)
      throw error
    }
  }

  /**
   * 标记所有预警为已读
   */
  async markAllAlertsAsRead(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('risk_alerts')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false)

    if (error) {
      logger.error('[RiskAlert] 标记所有预警失败:', error)
      throw error
    }
  }
}

// ============================================
// 全局实例工厂函数
// ============================================

let _riskAlertService: RiskAlertService | null = null

export function getRiskAlertService(): RiskAlertService {
  if (!_riskAlertService) {
    _riskAlertService = new RiskAlertService()
  }

  return _riskAlertService
}

// ============================================
// 导出
// ============================================

export { formatAlertMessage, getSeverity }
