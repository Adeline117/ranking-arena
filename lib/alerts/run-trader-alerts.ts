import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { buildTraderAlertDelivery } from './trader-alert-delivery'
import {
  evaluateTraderAlert,
  type TraderAlertMetric,
  type TraderAlertMetricConfig,
  type TraderAlertMetricState,
  type TraderAlertObservation,
} from './trader-alert-engine'

const MAX_ALERTS_PER_RUN = 1_000
const MAX_PENDING_PER_RUN = 5_000

type AlertRow = Pick<
  Database['public']['Tables']['trader_alerts']['Row'],
  | 'id'
  | 'user_id'
  | 'trader_id'
  | 'source'
  | 'alert_roi_change'
  | 'roi_change_threshold'
  | 'alert_drawdown'
  | 'drawdown_threshold'
  | 'alert_pnl_change'
  | 'pnl_change_threshold'
  | 'alert_score_change'
  | 'score_change_threshold'
  | 'alert_rank_change'
  | 'rank_change_threshold'
  | 'one_time'
>

type StateRow = Database['public']['Tables']['trader_alert_states']['Row']
type DeliveryRow = Database['public']['Tables']['trader_alert_deliveries']['Row']

interface TraderObservation extends TraderAlertObservation {
  traderId: string
  source: string
}

export interface DeliveredTraderAlert {
  deliveryId: string
  userId: string
  notificationType: string
  title: string
  message: string
  link: string
}

export interface TraderAlertRunResult {
  alertsConfigured: number
  alertsChecked: number
  alertsSkippedNoSubscription: number
  tradersChecked: number
  statesWritten: number
  alertsSent: number
  deliveryFailures: number
  deliveredAlerts: DeliveredTraderAlert[]
}

function stateKey(alertId: string, metric: string): string {
  return `${alertId}:${metric}`
}

function traderKey(traderId: string, source: string): string {
  return `${traderId}:${source}`
}

function metricValue(observation: TraderObservation, metric: TraderAlertMetric): number | null {
  const value = observation[metric]
  if (value == null || !Number.isFinite(value)) return null
  return metric === 'drawdown' ? Math.abs(value) : value
}

function configsFor(alert: AlertRow): Record<TraderAlertMetric, TraderAlertMetricConfig> {
  return {
    roi: {
      enabled: alert.alert_roi_change ?? false,
      threshold: alert.roi_change_threshold ?? 10,
    },
    pnl: {
      enabled: alert.alert_pnl_change ?? false,
      threshold: alert.pnl_change_threshold ?? 5_000,
    },
    score: {
      enabled: alert.alert_score_change ?? false,
      threshold: alert.score_change_threshold ?? 5,
    },
    rank: {
      enabled: alert.alert_rank_change ?? false,
      threshold: alert.rank_change_threshold ?? 5,
    },
    drawdown: {
      enabled: alert.alert_drawdown ?? false,
      threshold: alert.drawdown_threshold ?? 20,
    },
  }
}

function toMetricState(row: StateRow): TraderAlertMetricState {
  return {
    baselineValue: row.baseline_value,
    lastValue: row.last_value,
    baselineVersion: row.baseline_version,
  }
}

function observationForAlert(
  alert: AlertRow,
  observations: Map<string, TraderObservation>,
  byTrader: Map<string, TraderObservation[]>
): TraderObservation | null {
  if (alert.source) return observations.get(traderKey(alert.trader_id, alert.source)) ?? null

  // Legacy alerts without an exchange are safe only when the trader ID maps to
  // exactly one account. Guessing among multiple exchanges can alert on the
  // wrong person/account.
  const candidates = byTrader.get(alert.trader_id) ?? []
  return candidates.length === 1 ? candidates[0] : null
}

async function reserveDelivery(
  supabase: SupabaseClient<Database>,
  row: Database['public']['Tables']['trader_alert_deliveries']['Insert']
): Promise<DeliveryRow> {
  const { data, error } = await supabase
    .from('trader_alert_deliveries')
    .insert(row)
    .select('*')
    .single()

  if (!error && data) return data
  if (error?.code !== '23505') throw new Error(`Failed to reserve trader alert: ${error?.message}`)

  const { data: existing, error: existingError } = await supabase
    .from('trader_alert_deliveries')
    .select('*')
    .eq('alert_id', row.alert_id)
    .eq('metric', row.metric)
    .eq('baseline_version', row.baseline_version)
    .single()

  if (existingError || !existing) {
    throw new Error(`Failed to read reserved trader alert: ${existingError?.message}`)
  }
  return existing
}

async function recordDeliveryFailure(
  supabase: SupabaseClient<Database>,
  delivery: DeliveryRow,
  message: string
): Promise<void> {
  await supabase
    .from('trader_alert_deliveries')
    .update({
      attempt_count: delivery.attempt_count + 1,
      last_error: message.slice(0, 1_000),
      updated_at: new Date().toISOString(),
    })
    .eq('id', delivery.id)
}

async function finalizeDelivery(
  supabase: SupabaseClient<Database>,
  delivery: DeliveryRow,
  lastValue: number,
  observedAt: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('finalize_trader_alert_delivery', {
    p_delivery_id: delivery.id,
    p_last_value: lastValue,
    p_observed_at: observedAt,
  })

  if (error) {
    await recordDeliveryFailure(supabase, delivery, error.message)
    throw new Error(`Failed to finalize trader alert delivery: ${error.message}`)
  }
  return data
}

function deliveredAlertFrom(row: DeliveryRow): DeliveredTraderAlert {
  return {
    deliveryId: row.id,
    userId: row.user_id,
    notificationType: row.notification_type,
    title: row.title,
    message: row.message,
    link: row.link,
  }
}

export async function runTraderAlerts(
  supabase: SupabaseClient<Database>,
  now = new Date()
): Promise<TraderAlertRunResult> {
  const observedAt = now.toISOString()
  const { data: configuredAlerts, error: alertsError } = await supabase
    .from('trader_alerts')
    .select(
      'id, user_id, trader_id, source, alert_roi_change, roi_change_threshold, alert_drawdown, drawdown_threshold, alert_pnl_change, pnl_change_threshold, alert_score_change, score_change_threshold, alert_rank_change, rank_change_threshold, one_time'
    )
    .eq('enabled', true)
    .limit(MAX_ALERTS_PER_RUN)

  if (alertsError) throw new Error(`Failed to load trader alerts: ${alertsError.message}`)
  const allAlerts = (configuredAlerts ?? []) as AlertRow[]

  const emptyResult: TraderAlertRunResult = {
    alertsConfigured: allAlerts.length,
    alertsChecked: 0,
    alertsSkippedNoSubscription: 0,
    tradersChecked: 0,
    statesWritten: 0,
    alertsSent: 0,
    deliveryFailures: 0,
    deliveredAlerts: [],
  }
  if (allAlerts.length === 0) return emptyResult

  const userIds = [...new Set(allAlerts.map((alert) => alert.user_id))]
  const [
    { data: subscriptions, error: subscriptionsError },
    { data: activeProfiles, error: profilesError },
  ] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('user_id')
      .in('user_id', userIds)
      .in('status', ['active', 'trialing'])
      .in('tier', ['pro', 'lifetime']),
    supabase.from('user_profiles').select('id').in('id', userIds).is('deleted_at', null),
  ])

  if (subscriptionsError) {
    throw new Error(`Failed to verify trader alert subscriptions: ${subscriptionsError.message}`)
  }
  if (profilesError) {
    throw new Error(`Failed to verify trader alert account status: ${profilesError.message}`)
  }

  const subscribedUsers = new Set((subscriptions ?? []).map((row) => row.user_id))
  const activeUsers = new Set((activeProfiles ?? []).map((row) => row.id))
  const alerts = allAlerts.filter(
    (alert) => subscribedUsers.has(alert.user_id) && activeUsers.has(alert.user_id)
  )
  emptyResult.alertsSkippedNoSubscription = allAlerts.length - alerts.length
  if (alerts.length === 0) return emptyResult

  const traderIds = [...new Set(alerts.map((alert) => alert.trader_id))]
  const { data: leaderboardRows, error: leaderboardError } = await supabase
    .from('leaderboard_ranks')
    .select('source_trader_id, source, roi, pnl, max_drawdown, arena_score, rank')
    .in('source_trader_id', traderIds)
    .eq('season_id', '90D')

  if (leaderboardError) {
    throw new Error(`Failed to load trader observations: ${leaderboardError.message}`)
  }

  const observations = new Map<string, TraderObservation>()
  const observationsByTrader = new Map<string, TraderObservation[]>()
  for (const row of leaderboardRows ?? []) {
    const observation: TraderObservation = {
      traderId: row.source_trader_id,
      source: row.source,
      roi: row.roi,
      pnl: row.pnl,
      score: row.arena_score,
      rank: row.rank,
      drawdown: row.max_drawdown,
    }
    observations.set(traderKey(observation.traderId, observation.source), observation)
    const sameTrader = observationsByTrader.get(observation.traderId) ?? []
    sameTrader.push(observation)
    observationsByTrader.set(observation.traderId, sameTrader)
  }

  const alertIds = alerts.map((alert) => alert.id)
  const [{ data: stateRows, error: stateError }, { data: pendingRows, error: pendingError }] =
    await Promise.all([
      supabase.from('trader_alert_states').select('*').in('alert_id', alertIds),
      supabase
        .from('trader_alert_deliveries')
        .select('*')
        .in('alert_id', alertIds)
        .eq('status', 'pending')
        .limit(MAX_PENDING_PER_RUN),
    ])

  if (stateError) throw new Error(`Failed to load trader alert state: ${stateError.message}`)
  if (pendingError) throw new Error(`Failed to load pending trader alerts: ${pendingError.message}`)

  const states = new Map<string, TraderAlertMetricState>()
  for (const row of stateRows ?? [])
    states.set(stateKey(row.alert_id, row.metric), toMetricState(row))

  const alertsById = new Map(alerts.map((alert) => [alert.id, alert]))
  const processedPending = new Set<string>()
  const deliveredAlerts: DeliveredTraderAlert[] = []
  let deliveryFailures = 0

  // Retry already-reserved events first. Their stored payload remains stable
  // even if the latest observation has moved again.
  for (const delivery of pendingRows ?? []) {
    const alert = alertsById.get(delivery.alert_id)
    if (!alert) continue
    const observation = observationForAlert(alert, observations, observationsByTrader)
    if (!observation) continue
    const metric = delivery.metric as TraderAlertMetric
    const lastValue = metricValue(observation, metric) ?? delivery.new_value
    processedPending.add(stateKey(alert.id, metric))

    try {
      const newlyDelivered = await finalizeDelivery(supabase, delivery, lastValue, observedAt)
      states.set(stateKey(alert.id, metric), {
        baselineValue: delivery.new_value,
        lastValue,
        baselineVersion: delivery.baseline_version + 1,
      })
      if (newlyDelivered) deliveredAlerts.push(deliveredAlertFrom(delivery))
    } catch {
      deliveryFailures++
    }
  }

  const stateWrites: Database['public']['Tables']['trader_alert_states']['Insert'][] = []

  for (const alert of alerts) {
    const observation = observationForAlert(alert, observations, observationsByTrader)
    if (!observation) continue

    const alertStates: Partial<Record<TraderAlertMetric, TraderAlertMetricState>> = {}
    for (const metric of ['roi', 'pnl', 'score', 'rank', 'drawdown'] as const) {
      const stored = states.get(stateKey(alert.id, metric))
      if (stored) alertStates[metric] = stored
    }

    const evaluations = evaluateTraderAlert(configsFor(alert), observation, alertStates)
    let oneTimeDelivered = false

    for (const evaluation of evaluations) {
      const key = stateKey(alert.id, evaluation.metric)
      if (processedPending.has(key) || oneTimeDelivered) continue

      if (!evaluation.event) {
        stateWrites.push({
          alert_id: alert.id,
          metric: evaluation.metric,
          baseline_value: evaluation.nextState.baselineValue!,
          last_value: evaluation.nextState.lastValue!,
          baseline_version: evaluation.nextState.baselineVersion,
          observed_at: observedAt,
          updated_at: observedAt,
        })
        states.set(key, evaluation.nextState)
        continue
      }

      const payload = buildTraderAlertDelivery({
        metric: evaluation.metric,
        traderId: alert.trader_id,
        source: observation.source,
        oldValue: evaluation.event.oldValue,
        newValue: evaluation.event.newValue,
      })

      try {
        const delivery = await reserveDelivery(supabase, {
          alert_id: alert.id,
          user_id: alert.user_id,
          metric: evaluation.metric,
          baseline_version: evaluation.event.baselineVersion,
          old_value: evaluation.event.oldValue,
          new_value: evaluation.event.newValue,
          absolute_change: evaluation.event.absoluteChange,
          notification_type: payload.notificationType,
          title: payload.title,
          message: payload.message,
          link: payload.link,
        })
        const lastValue = metricValue(observation, evaluation.metric) ?? delivery.new_value
        const newlyDelivered = await finalizeDelivery(supabase, delivery, lastValue, observedAt)
        states.set(key, {
          baselineValue: delivery.new_value,
          lastValue,
          baselineVersion: delivery.baseline_version + 1,
        })
        if (newlyDelivered) deliveredAlerts.push(deliveredAlertFrom(delivery))
        if (alert.one_time) oneTimeDelivered = true
      } catch {
        deliveryFailures++
      }
    }
  }

  if (stateWrites.length > 0) {
    const { error: stateWriteError } = await supabase
      .from('trader_alert_states')
      .upsert(stateWrites, { onConflict: 'alert_id,metric' })
    if (stateWriteError)
      throw new Error(`Failed to persist trader alert state: ${stateWriteError.message}`)
  }

  return {
    alertsConfigured: allAlerts.length,
    alertsChecked: alerts.length,
    alertsSkippedNoSubscription: allAlerts.length - alerts.length,
    tradersChecked: new Set(
      alerts
        .map((alert) => observationForAlert(alert, observations, observationsByTrader))
        .filter((value): value is TraderObservation => value != null)
        .map((observation) => traderKey(observation.traderId, observation.source))
    ).size,
    statesWritten: stateWrites.length,
    alertsSent: deliveredAlerts.length,
    deliveryFailures,
    deliveredAlerts,
  }
}
