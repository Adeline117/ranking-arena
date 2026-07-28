export interface IngestServingStartupSteps<TConsumers, TFailover> {
  startHeartbeat: () => Promise<NodeJS.Timeout>
  createConsumers: () => TConsumers
  reconcileSchedulers: () => Promise<void>
  startReconcileTimer: () => NodeJS.Timeout
  startFailover: () => TFailover
  markReady: () => void
}

export interface IngestServingRuntime<TConsumers, TFailover> {
  heartbeatTimer: NodeJS.Timeout
  consumers: TConsumers
  reconcileTimer: NodeJS.Timeout
  failover: TFailover
}

/**
 * The first shared-Redis HSET is the serving boundary. Keeping every consumer,
 * scheduler, failover process, and ready log behind one awaited orchestration
 * point makes a rejected heartbeat structurally unable to become fail-open.
 */
export async function startIngestServingAfterHeartbeat<TConsumers, TFailover>(
  steps: IngestServingStartupSteps<TConsumers, TFailover>
): Promise<IngestServingRuntime<TConsumers, TFailover>> {
  const heartbeatTimer = await steps.startHeartbeat()
  const consumers = steps.createConsumers()
  await steps.reconcileSchedulers()
  const reconcileTimer = steps.startReconcileTimer()
  const failover = steps.startFailover()
  steps.markReady()
  return { heartbeatTimer, consumers, reconcileTimer, failover }
}
