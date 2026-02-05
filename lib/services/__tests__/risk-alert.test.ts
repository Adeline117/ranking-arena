/**
 * Risk Alert Service Unit Tests
 */

import {
  RiskAlertService,
  AlertType,
  AlertSeverity,
  RiskAlert,
  AlertConfig,
  DEFAULT_THRESHOLDS,
  getSeverity,
  formatAlertMessage,
} from '../risk-alert'

// Create a chainable mock that handles multiple .eq() calls
const createChainableMock = () => {
  const mock: Record<string, jest.Mock> = {}
  const methods = ['from', 'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']
  methods.forEach(method => {
    mock[method] = jest.fn(() => mock)
  })
  return mock
}

let mockSupabase: ReturnType<typeof createChainableMock>

// Mock createClient
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    mockSupabase = createChainableMock()
    return mockSupabase
  }),
}))

describe('Risk Alert Service', () => {
  let service: RiskAlertService

  beforeEach(() => {
    jest.clearAllMocks()
    service = new RiskAlertService('http://localhost:54321', 'test-key')
  })

  describe('getSeverity', () => {
    it('should return critical for severe drawdown', () => {
      expect(getSeverity('drawdown', -30, 15)).toBe('critical')
    })

    it('should return warning for moderate drawdown', () => {
      expect(getSeverity('drawdown', -18, 15)).toBe('warning')
    })

    it('should return info for minor drawdown', () => {
      expect(getSeverity('drawdown', -10, 15)).toBe('info')
    })

    it('should return critical for severe rank drop', () => {
      expect(getSeverity('rank_drop', 25, 10)).toBe('critical')
    })

    it('should return warning for moderate rank drop', () => {
      expect(getSeverity('rank_drop', 15, 10)).toBe('warning')
    })

    it('should return critical for very low win rate', () => {
      expect(getSeverity('win_rate_drop', 30, 45)).toBe('critical')
    })

    it('should return warning for low win rate', () => {
      expect(getSeverity('win_rate_drop', 40, 45)).toBe('warning')
    })

    it('should return critical for severe ROI change', () => {
      expect(getSeverity('roi_change', -25, -10)).toBe('critical')
    })

    it('should return warning for moderate ROI change', () => {
      expect(getSeverity('roi_change', -15, -10)).toBe('warning')
    })
  })

  describe('formatAlertMessage', () => {
    it('should format drawdown message in Chinese', () => {
      const message = formatAlertMessage('drawdown', 'TestTrader', -20, 0, 'zh')
      expect(message).toContain('TestTrader')
      expect(message).toContain('20.0%')
    })

    it('should format drawdown message in English', () => {
      const message = formatAlertMessage('drawdown', 'TestTrader', -20, 0, 'en')
      expect(message).toContain('TestTrader')
      expect(message).toContain('drawdown')
    })

    it('should format rank drop message', () => {
      const message = formatAlertMessage('rank_drop', 'TestTrader', 150, 100, 'zh')
      expect(message).toContain('100')
      expect(message).toContain('150')
    })

    it('should format win rate message', () => {
      const message = formatAlertMessage('win_rate_drop', 'TestTrader', 35, 0, 'zh')
      expect(message).toContain('35.0%')
    })

    it('should format ROI change message', () => {
      const message = formatAlertMessage('roi_change', 'TestTrader', -15, 10, 'en')
      expect(message).toContain('10.0%')
      expect(message).toContain('-15.0%')
    })
  })

  describe('checkDrawdownAlert', () => {
    it('should create alert when drawdown exceeds threshold', async () => {
      const mockAlert = {
        id: 'alert-1',
        user_id: 'user-1',
        trader_id: 'trader-1',
        trader_handle: 'TestTrader',
        alert_type: 'drawdown',
        severity: 'warning',
        threshold: 15,
        current_value: -20,
        previous_value: 0,
        message: 'Test message',
        created_at: new Date().toISOString(),
        is_read: false,
      }

      mockSupabase.single.mockResolvedValueOnce({ data: mockAlert, error: null })

      const result = await service.checkDrawdownAlert(
        'user-1',
        'trader-1',
        'TestTrader',
        -20,
        15
      )

      expect(result).not.toBeNull()
      expect(result?.alertType).toBe('drawdown')
      expect(mockSupabase.from).toHaveBeenCalledWith('risk_alerts')
    })

    it('should not create alert when drawdown is below threshold', async () => {
      const result = await service.checkDrawdownAlert(
        'user-1',
        'trader-1',
        'TestTrader',
        -10,
        15
      )

      expect(result).toBeNull()
      expect(mockSupabase.insert).not.toHaveBeenCalled()
    })
  })

  describe('checkRankDropAlert', () => {
    it('should create alert when rank drops significantly', async () => {
      const mockAlert = {
        id: 'alert-2',
        user_id: 'user-1',
        trader_id: 'trader-1',
        trader_handle: 'TestTrader',
        alert_type: 'rank_drop',
        severity: 'warning',
        threshold: 10,
        current_value: 150,
        previous_value: 100,
        message: 'Test message',
        created_at: new Date().toISOString(),
        is_read: false,
      }

      mockSupabase.single.mockResolvedValueOnce({ data: mockAlert, error: null })

      const result = await service.checkRankDropAlert(
        'user-1',
        'trader-1',
        'TestTrader',
        150,
        100,
        10
      )

      expect(result).not.toBeNull()
      expect(result?.alertType).toBe('rank_drop')
    })

    it('should not create alert when rank drop is within threshold', async () => {
      const result = await service.checkRankDropAlert(
        'user-1',
        'trader-1',
        'TestTrader',
        105,
        100,
        10
      )

      expect(result).toBeNull()
    })
  })

  describe('checkWinRateAlert', () => {
    it('should create alert when win rate drops below threshold', async () => {
      const mockAlert = {
        id: 'alert-3',
        user_id: 'user-1',
        trader_id: 'trader-1',
        trader_handle: 'TestTrader',
        alert_type: 'win_rate_drop',
        severity: 'warning',
        threshold: 45,
        current_value: 40,
        previous_value: 0,
        message: 'Test message',
        created_at: new Date().toISOString(),
        is_read: false,
      }

      mockSupabase.single.mockResolvedValueOnce({ data: mockAlert, error: null })

      const result = await service.checkWinRateAlert(
        'user-1',
        'trader-1',
        'TestTrader',
        40,
        45
      )

      expect(result).not.toBeNull()
      expect(result?.alertType).toBe('win_rate_drop')
    })

    it('should not create alert when win rate is above threshold', async () => {
      const result = await service.checkWinRateAlert(
        'user-1',
        'trader-1',
        'TestTrader',
        50,
        45
      )

      expect(result).toBeNull()
    })
  })

  describe('getUserAlertConfigs', () => {
    it('should return user alert configurations', async () => {
      const mockConfigs = [
        {
          id: 'config-1',
          user_id: 'user-1',
          trader_id: 'trader-1',
          trader_handle: 'TestTrader',
          alert_type: 'drawdown',
          threshold: 15,
          enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      // Make the second eq return a promise
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase)  // First .eq('user_id', userId)
        .mockResolvedValueOnce({ data: mockConfigs, error: null })  // Second .eq('enabled', true)

      const result = await service.getUserAlertConfigs('user-1')

      expect(result).toHaveLength(1)
      expect(result[0].alertType).toBe('drawdown')
    })
  })

  describe('getUnreadAlerts', () => {
    it('should return unread alerts for user', async () => {
      const mockAlerts = [
        {
          id: 'alert-1',
          user_id: 'user-1',
          trader_id: 'trader-1',
          trader_handle: 'TestTrader',
          alert_type: 'drawdown',
          severity: 'warning',
          threshold: 15,
          current_value: -20,
          message: 'Test message',
          created_at: new Date().toISOString(),
          is_read: false,
        },
      ]

      mockSupabase.limit.mockResolvedValueOnce({ data: mockAlerts, error: null })

      const result = await service.getUnreadAlerts('user-1')

      expect(result).toHaveLength(1)
      expect(result[0].isRead).toBe(false)
    })
  })

  describe('markAlertAsRead', () => {
    it('should mark alert as read', async () => {
      // Make the second eq return a promise
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase)  // First .eq('id', alertId)
        .mockResolvedValueOnce({ error: null })  // Second .eq('user_id', userId)

      await service.markAlertAsRead('alert-1', 'user-1')

      expect(mockSupabase.update).toHaveBeenCalledWith({ is_read: true })
    })
  })

  describe('markAllAlertsAsRead', () => {
    it('should mark all alerts as read for user', async () => {
      // Make the second eq return a promise
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase)  // First .eq('user_id', userId)
        .mockResolvedValueOnce({ error: null })  // Second .eq('is_read', false)

      await service.markAllAlertsAsRead('user-1')

      expect(mockSupabase.update).toHaveBeenCalledWith({ is_read: true })
    })
  })

  describe('DEFAULT_THRESHOLDS', () => {
    it('should have valid drawdown thresholds', () => {
      expect(DEFAULT_THRESHOLDS.drawdown.warning).toBe(15)
      expect(DEFAULT_THRESHOLDS.drawdown.critical).toBe(25)
    })

    it('should have valid rank drop thresholds', () => {
      expect(DEFAULT_THRESHOLDS.rank_drop.warning).toBe(10)
      expect(DEFAULT_THRESHOLDS.rank_drop.critical).toBe(20)
    })

    it('should have valid win rate thresholds', () => {
      expect(DEFAULT_THRESHOLDS.win_rate_drop.warning).toBe(45)
      expect(DEFAULT_THRESHOLDS.win_rate_drop.critical).toBe(35)
    })

    it('should have valid ROI change thresholds', () => {
      expect(DEFAULT_THRESHOLDS.roi_change.warning).toBe(-10)
      expect(DEFAULT_THRESHOLDS.roi_change.critical).toBe(-20)
    })
  })
})
