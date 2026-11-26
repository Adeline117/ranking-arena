import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'
import { hasFeatureAccess } from '@/lib/types/premium'
import { createLogger } from '@/lib/utils/logger'
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
const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const
const PUBLIC_ALERT_PERIOD = '90D'

const log = createLogger('trader-alerts')

/**
 * State rows written before the sealed public cohort existed have no durable
 * evidence provenance. Keep them out of every future comparison rather than
 * turning their historical raw values into a newly delivered alert.
 */
export const SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION = 1_000_000_000

const PUBLIC_ALERT_RANKING_COLUMNS =
  'season_id,source,source_trader_id,roi,pnl,max_drawdown,arena_score,rank,win_rate,score_completeness,metrics_estimated,is_outlier,computed_at,idle_window'

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
  /**
   * The row had no ROI and no PnL in the period (view column `idle_window`).
   * Its ROI/PnL are 0, its score is the 0.01 floor and its rank is a tail
   * position — none of them is performance, so an idle row neither fires an
   * alert nor moves a baseline (see runTraderAlerts).
   */
  idleWindow: boolean
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
  /** Alerts left untouched this run because the trader's row is idle-window. */
  alertsSkippedIdleWindow: number
  /**
   * Alerts with the drawdown condition enabled whose trader publishes no max
   * drawdown: only that condition was skipped, the other metrics still ran.
   */
  drawdownConditionsSkippedNoDrawdown: number
  tradersChecked: number
  statesWritten: number
  alertsSent: number
  deliveryFailures: number
  deliveredAlerts: DeliveredTraderAlert[]
}

function stateKey(alertId: string, metric: string): string {
  return `${alertId}:${metric}`
}

function deliveryKey(alertId: string, metric: string, baselineVersion: number): string {
  return `${stateKey(alertId, metric)}:${baselineVersion}`
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

function toMetricState(row: StateRow): TraderAlertMetricState | null {
  if (
    !Number.isSafeInteger(row.baseline_version) ||
    row.baseline_version < SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION
  ) {
    return null
  }
  return {
    baselineValue: row.baseline_value,
    lastValue: row.last_value,
    baselineVersion: row.baseline_version,
  }
}

function unseededSealedMetricState(): TraderAlertMetricState {
  return {
    baselineValue: null,
    lastValue: null,
    baselineVersion: SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function observationFromPublicRankingRow(row: unknown): TraderObservation | null {
  if (!isRecord(row)) return null
  if (typeof row.source_trader_id !== 'string' || typeof row.source !== 'string') return null

  const metrics = {
    roi: row.roi,
    pnl: row.pnl,
    score: row.arena_score,
    rank: row.rank,
  }
  if (
    Object.values(metrics).some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    return null
  }

  // Max drawdown is optional on a public row (score_completeness partial /
  // minimal, or mdd_contradiction). Null means "not published": only the
  // drawdown condition is skipped for that trader, never the whole trader.
  // A present value that is not a finite number is still a malformed row.
  const rawDrawdown = row.max_drawdown
  if (rawDrawdown != null && (typeof rawDrawdown !== 'number' || !Number.isFinite(rawDrawdown))) {
    return null
  }

  return {
    traderId: row.source_trader_id,
    source: row.source,
    roi: metrics.roi as number,
    pnl: metrics.pnl as number,
    score: metrics.score as number,
    rank: metrics.rank as number,
    drawdown: rawDrawdown ?? null,
    idleWindow: row.idle_window === true,
  }
}

function observationForAlert(
  alert: AlertRow,
  observations: Map<string, TraderObservation>
): TraderObservation | null {
  // `source_trader_id` is only source-local. A legacy alert with no source
  // cannot prove which account it targets, even if the current public view
  // happens to expose one matching row (another source can be unpublished).
  // It remains inert until its owner saves an explicit source-bound alert.
  if (!alert.source) return null
  return observations.get(traderKey(alert.trader_id, alert.source)) ?? null
}

/**
 * The observation an alert may be evaluated against, or null.
 *
 * An idle-window row is not evaluated at all: ROI 0 / PnL 0 / score 0.01 / a
 * tail rank are placeholders, so comparing them with the last real values
 * would announce "ROI changed" or "rank dropped" for an account that simply
 * did not trade. Baselines are left as they were, so when the trader shows
 * performance again the change is measured from the last real observation.
 * Pending deliveries wait the same way they do for an unpublished trader.
 */
function evaluableObservationForAlert(
  alert: AlertRow,
  observations: Map<string, TraderObservation>
): TraderObservation | null {
  const observation = observationForAlert(alert, observations)
  if (!observation || observation.idleWindow) return null
  return observation
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
    alertsSkippedIdleWindow: 0,
    drawdownConditionsSkippedNoDrawdown: 0,
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
  // Mirror the API gate (`hasFeatureAccess`, which honours PRO_FREE_PROMO):
  // during the promo every active account may configure alerts, so the
  // scheduler must not silently drop them for lacking a paid row.
  const promoUnlocked = hasFeatureAccess('free', 'trader_alerts')
  const alerts = allAlerts.filter(
    (alert) =>
      (promoUnlocked || subscribedUsers.has(alert.user_id)) && activeUsers.has(alert.user_id)
  )
  emptyResult.alertsSkippedNoSubscription = allAlerts.length - alerts.length
  if (alerts.length === 0) return emptyResult

  const traderIds = [...new Set(alerts.map((alert) => alert.trader_id))]
  const { data: rankingRows, error: rankingError } = await supabase
    .from(PUBLIC_RANKED_LEADERBOARD as never)
    .select(PUBLIC_ALERT_RANKING_COLUMNS)
    .in('source_trader_id', traderIds)
    .eq('season_id', PUBLIC_ALERT_PERIOD)
    .not('rank', 'is', null)

  if (rankingError) {
    throw new Error(`Failed to load public trader observations: ${rankingError.message}`)
  }

  const sanitizedCohort = sanitizePublicRankingPayload(
    { traders: (rankingRows ?? []) as unknown[], period: PUBLIC_ALERT_PERIOD },
    { expectedPeriod: PUBLIC_ALERT_PERIOD, nowMs: now.getTime() }
  ) as { traders?: unknown[]; ranking_visibility?: unknown }
  // A partial result has no complete cohort proof. Do not use even the rows
  // that survived sanitization to advance a user-visible alert baseline.
  const verifiedRows =
    sanitizedCohort.ranking_visibility === 'partial' ||
    sanitizedCohort.ranking_visibility === 'unknown'
      ? []
      : (sanitizedCohort.traders ?? [])

  const observations = new Map<string, TraderObservation>()
  for (const row of verifiedRows) {
    const observation = observationFromPublicRankingRow(row)
    if (!observation) continue
    observations.set(traderKey(observation.traderId, observation.source), observation)
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
  for (const row of stateRows ?? []) {
    const state = toMetricState(row)
    if (state) states.set(stateKey(row.alert_id, row.metric), state)
  }

  const alertsById = new Map(alerts.map((alert) => [alert.id, alert]))
  const processedPending = new Set<string>()
  const deliveredAlerts: DeliveredTraderAlert[] = []
  let deliveryFailures = 0

  // Retry only events reserved after the sealed evidence epoch. Legacy pending
  // rows contain raw historical values/messages, so finalizing them would leak
  // data that can no longer be proven by the public cohort.
  for (const delivery of pendingRows ?? []) {
    if (delivery.baseline_version < SEALED_PUBLIC_RANKING_ALERT_BASELINE_VERSION) continue
    const alert = alertsById.get(delivery.alert_id)
    if (!alert) continue
    const observation = evaluableObservationForAlert(alert, observations)
    if (!observation) continue
    const metric = delivery.metric as TraderAlertMetric
    const lastValue = metricValue(observation, metric) ?? delivery.new_value
    processedPending.add(deliveryKey(alert.id, metric, delivery.baseline_version))

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

  let alertsSkippedIdleWindow = 0
  let drawdownConditionsSkippedNoDrawdown = 0

  for (const alert of alerts) {
    const observation = evaluableObservationForAlert(alert, observations)
    if (!observation) {
      if (observationForAlert(alert, observations)?.idleWindow) alertsSkippedIdleWindow++
      continue
    }
    // evaluateTraderAlert already leaves a null metric out; count the alerts
    // whose owner asked for the drawdown condition so the skip is visible.
    if (observation.drawdown == null && alert.alert_drawdown === true) {
      drawdownConditionsSkippedNoDrawdown++
    }

    const alertStates: Partial<Record<TraderAlertMetric, TraderAlertMetricState>> = {}
    for (const metric of ['roi', 'pnl', 'score', 'rank', 'drawdown'] as const) {
      const stored = states.get(stateKey(alert.id, metric))
      alertStates[metric] = stored ?? unseededSealedMetricState()
    }

    const evaluations = evaluateTraderAlert(configsFor(alert), observation, alertStates)
    let oneTimeDelivered = false

    for (const evaluation of evaluations) {
      const key = stateKey(alert.id, evaluation.metric)

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

      if (
        processedPending.has(
          deliveryKey(alert.id, evaluation.metric, evaluation.event.baselineVersion)
        ) ||
        oneTimeDelivered
      ) {
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

  if (alertsSkippedIdleWindow > 0 || drawdownConditionsSkippedNoDrawdown > 0) {
    log.info('skipped alert conditions that have no published basis', {
      alertsSkippedIdleWindow,
      drawdownConditionsSkippedNoDrawdown,
      alertsChecked: alerts.length,
    })
  }

  return {
    alertsConfigured: allAlerts.length,
    alertsChecked: alerts.length,
    alertsSkippedNoSubscription: allAlerts.length - alerts.length,
    alertsSkippedIdleWindow,
    drawdownConditionsSkippedNoDrawdown,
    tradersChecked: new Set(
      alerts
        .map((alert) => evaluableObservationForAlert(alert, observations))
        .filter((value): value is TraderObservation => value != null)
        .map((observation) => traderKey(observation.traderId, observation.source))
    ).size,
    statesWritten: stateWrites.length,
    alertsSent: deliveredAlerts.length,
    deliveryFailures,
    deliveredAlerts,
  }
}
