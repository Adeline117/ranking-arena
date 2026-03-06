export type AlertType = 'roi_change' | 'drawdown' | 'rank_change'
export type Operator = '>' | '<' | '>=' | '<=' | 'change_by'
export type AlertChannel = 'email' | 'push'

export interface AlertCondition {
  id: string
  type: AlertType
  operator: Operator
  threshold: number
  isPercent: boolean
  channels: AlertChannel[]
  isActive: boolean
}

export interface AlertTypeInfo {
  type: AlertType
  label: string
  icon: React.ReactNode
  description: string
}

export interface OperatorOption {
  value: Operator
  label: string
}

export interface AdvancedAlertsProps {
  isPro: boolean
  isLoggedIn?: boolean
  traderId?: string
  traderHandle?: string
  /** Existing alert conditions */
  existingConditions?: AlertCondition[]
  /** Callback when conditions change */
  onConditionsChange?: (conditions: AlertCondition[]) => void
}

export const DEFAULT_CONDITION: Partial<AlertCondition> = {
  type: 'roi_change',
  operator: 'change_by',
  threshold: 10,
  isPercent: true,
  channels: ['push'],
  isActive: true,
}

export const DEMO_CONDITIONS: AlertCondition[] = [
  {
    id: '1',
    type: 'roi_change',
    operator: 'change_by',
    threshold: 10,
    isPercent: true,
    channels: ['push'],
    isActive: true,
  },
  {
    id: '2',
    type: 'drawdown',
    operator: '>',
    threshold: 15,
    isPercent: true,
    channels: ['email', 'push'],
    isActive: true,
  },
]
