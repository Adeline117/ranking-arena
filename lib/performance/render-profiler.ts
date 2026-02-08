/**
 * Render Profiler Utility
 *
 * Development tool for measuring component render times.
 * Automatically disabled in production.
 */

interface RenderMeasurement {
  componentName: string
  phase: 'mount' | 'update'
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
}

const measurements: RenderMeasurement[] = []
const slowThreshold = 16 // 16ms = 1 frame at 60fps

/**
 * React Profiler callback for measuring render performance.
 * Use with React.Profiler component.
 *
 * @example
 * <Profiler id="RankingTable" onRender={onRenderCallback}>
 *   <RankingTable />
 * </Profiler>
 */
export function onRenderCallback(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  if (process.env.NODE_ENV !== 'development') return

  const measurement: RenderMeasurement = {
    componentName: id,
    phase: phase === 'nested-update' ? 'update' : phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  }

  measurements.push(measurement)

  // Log slow renders
  if (actualDuration > slowThreshold) {
    console.warn(
      `[RenderProfiler] Slow render detected: ${id}`,
      `\n  Phase: ${phase}`,
      `\n  Actual: ${actualDuration.toFixed(2)}ms`,
      `\n  Base: ${baseDuration.toFixed(2)}ms`,
      `\n  This render took longer than 16ms (1 frame)`
    )
  }

  // Keep only last 100 measurements
  if (measurements.length > 100) {
    measurements.shift()
  }
}

/**
 * Get all render measurements for a component.
 */
export function getMeasurements(componentName?: string): RenderMeasurement[] {
  if (componentName) {
    return measurements.filter((m) => m.componentName === componentName)
  }
  return [...measurements]
}

/**
 * Get average render time for a component.
 */
export function getAverageRenderTime(componentName: string): number {
  const componentMeasurements = getMeasurements(componentName)
  if (componentMeasurements.length === 0) return 0

  const total = componentMeasurements.reduce((sum, m) => sum + m.actualDuration, 0)
  return total / componentMeasurements.length
}

/**
 * Clear all measurements.
 */
export function clearMeasurements(): void {
  measurements.length = 0
}

/**
 * Print a summary of render performance.
 */
export function printRenderSummary(): void {
  if (process.env.NODE_ENV !== 'development') return

  const byComponent = new Map<string, RenderMeasurement[]>()

  for (const m of measurements) {
    const list = byComponent.get(m.componentName) || []
    list.push(m)
    byComponent.set(m.componentName, list)
  }

  console.group('[RenderProfiler] Summary')

  for (const [name, list] of byComponent) {
    const mounts = list.filter((m) => m.phase === 'mount')
    const updates = list.filter((m) => m.phase === 'update')
    const avgMount = mounts.length > 0
      ? mounts.reduce((s, m) => s + m.actualDuration, 0) / mounts.length
      : 0
    const avgUpdate = updates.length > 0
      ? updates.reduce((s, m) => s + m.actualDuration, 0) / updates.length
      : 0
    const slowRenders = list.filter((m) => m.actualDuration > slowThreshold).length

    console.warn(
      `${name}:`,
      `\n  Mounts: ${mounts.length} (avg: ${avgMount.toFixed(2)}ms)`,
      `\n  Updates: ${updates.length} (avg: ${avgUpdate.toFixed(2)}ms)`,
      `\n  Slow renders: ${slowRenders}`
    )
  }

  console.groupEnd()
}

/**
 * Hook to track component mount/unmount times.
 */
export function useRenderTiming(componentName: string) {
  if (process.env.NODE_ENV !== 'development') return

  const mountTime = performance.now()

  return () => {
    const unmountTime = performance.now()
    console.warn(
      `[RenderProfiler] ${componentName} lifecycle:`,
      `\n  Total lifetime: ${(unmountTime - mountTime).toFixed(2)}ms`
    )
  }
}

// Export utilities for DevTools
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as unknown as Record<string, unknown>).__RENDER_PROFILER__ = {
    getMeasurements,
    getAverageRenderTime,
    clearMeasurements,
    printRenderSummary,
  }
}
