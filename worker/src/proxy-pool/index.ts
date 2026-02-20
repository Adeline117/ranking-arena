/**
 * Proxy Pool Manager
 * Manages multiple proxy nodes via ClashX REST API
 * Features:
 * - Health checking
 * - Automatic failover
 * - Success rate tracking
 * - Region-based proxy selection
 */

import type { ProxyNode, ProxyPoolConfig, ProxyStatus } from '../types.js'
import { logger } from '../logger.js'

const DEFAULT_CONFIG: ProxyPoolConfig = {
  clashApiUrl: 'http://127.0.0.1:9090',
  healthCheckInterval: 60000, // 1 minute
  failoverThreshold: 0.5, // Switch if success rate drops below 50%
  preferredRegions: ['SG', 'JP', 'HK', 'TW'],
}

interface ClashProxyInfo {
  name: string
  type: string
  udp?: boolean
  server?: string
  port?: number
  now?: string
  history?: Array<{
    time: string
    delay: number
  }>
}

interface ClashProxiesResponse {
  proxies: Record<string, ClashProxyInfo>
}

interface ClashDelayResponse {
  delay: number
}

export class ProxyPoolManager {
  private config: ProxyPoolConfig
  private nodes: Map<string, ProxyNode> = new Map()
  private activeNodeId: string | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null
  private requestStats: Map<string, { success: number; failed: number }> = new Map()

  constructor(config?: Partial<ProxyPoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ============================================
  // Initialization
  // ============================================

  async initialize(): Promise<void> {
    console.log('[ProxyPool] Initializing proxy pool...')
    await this.refreshProxyList()
    await this.runHealthCheck()
    this.startHealthCheckTimer()
    console.log(`[ProxyPool] Initialized with ${this.nodes.size} proxies`)
  }

  async shutdown(): Promise<void> {
    console.log('[ProxyPool] Shutting down...')
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  // ============================================
  // Clash API Interactions
  // ============================================

  private async clashRequest<T>(
    path: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.config.clashApiUrl}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.clashApiSecret) {
      headers['Authorization'] = `Bearer ${this.config.clashApiSecret}`
    }

    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    })

    if (!response.ok) {
      throw new Error(`Clash API error: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<T>
  }

  async refreshProxyList(): Promise<void> {
    try {
      const data = await this.clashRequest<ClashProxiesResponse>('/proxies')
      const proxies = data.proxies || {}

      for (const [name, info] of Object.entries(proxies)) {
        // Skip selector groups and built-in proxies
        if (
          info.type === 'Selector' ||
          info.type === 'URLTest' ||
          info.type === 'Fallback' ||
          info.type === 'LoadBalance' ||
          name === 'DIRECT' ||
          name === 'REJECT' ||
          name === 'GLOBAL'
        ) {
          continue
        }

        const existing = this.nodes.get(name)
        const region = this.detectRegion(name)
        
        this.nodes.set(name, {
          id: name,
          name: name,
          type: 'clash',
          region,
          host: info.server || 'unknown',
          port: info.port || 0,
          status: existing?.status || 'unknown',
          lastCheck: existing?.lastCheck || new Date(),
          successRate: existing?.successRate || 1,
          avgLatency: this.getLatencyFromHistory(info.history),
          totalRequests: existing?.totalRequests || 0,
          failedRequests: existing?.failedRequests || 0,
        })
      }

      console.log(`[ProxyPool] Refreshed proxy list: ${this.nodes.size} nodes`)
    } catch (err) {
      logger.error('[ProxyPool] Failed to refresh proxy list', err instanceof Error ? err : new Error(String(err)))
    }
  }

  private detectRegion(name: string): string | undefined {
    const regionPatterns: Record<string, RegExp> = {
      SG: /singapore|sg|新加坡/i,
      JP: /japan|jp|日本|tokyo|osaka/i,
      HK: /hongkong|hk|香港/i,
      TW: /taiwan|tw|台湾|台北/i,
      US: /united states|us|usa|美国|los angeles|seattle|new york/i,
      KR: /korea|kr|韩国|首尔/i,
    }

    for (const [region, pattern] of Object.entries(regionPatterns)) {
      if (pattern.test(name)) {
        return region
      }
    }

    return undefined
  }

  private getLatencyFromHistory(
    history?: Array<{ time: string; delay: number }>
  ): number {
    if (!history || history.length === 0) return 0
    const recent = history.slice(-5)
    const validDelays = recent.filter((h) => h.delay > 0).map((h) => h.delay)
    if (validDelays.length === 0) return 0
    return Math.round(validDelays.reduce((a, b) => a + b, 0) / validDelays.length)
  }

  // ============================================
  // Health Checking
  // ============================================

  private startHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
    }
    this.healthCheckTimer = setInterval(
      () => this.runHealthCheck(),
      this.config.healthCheckInterval
    )
  }

  async runHealthCheck(): Promise<void> {
    console.log('[ProxyPool] Running health check...')
    const checkPromises: Promise<void>[] = []

    for (const node of this.nodes.values()) {
      checkPromises.push(this.checkNode(node.id))
    }

    await Promise.allSettled(checkPromises)

    // Update success rates from request stats
    for (const [nodeId, stats] of this.requestStats.entries()) {
      const node = this.nodes.get(nodeId)
      if (node) {
        const total = stats.success + stats.failed
        node.successRate = total > 0 ? stats.success / total : 1
        node.totalRequests = total
        node.failedRequests = stats.failed
      }
    }

    // Check if we need to failover
    await this.maybeFailover()
  }

  private async checkNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId)
    if (!node) return

    try {
      // Use Clash's delay test endpoint
      const data = await this.clashRequest<ClashDelayResponse>(
        `/proxies/${encodeURIComponent(nodeId)}/delay?timeout=5000&url=http://www.gstatic.com/generate_204`
      )

      node.avgLatency = data.delay || 0
      node.status = data.delay > 0 ? 'active' : 'down'
      node.lastCheck = new Date()
    } catch {
      node.status = 'down'
      node.avgLatency = 0
      node.lastCheck = new Date()
    }
  }

  private async maybeFailover(): Promise<void> {
    if (!this.activeNodeId) return

    const activeNode = this.nodes.get(this.activeNodeId)
    if (!activeNode) return

    // Check if active node is degraded
    if (
      activeNode.status === 'down' ||
      activeNode.successRate < this.config.failoverThreshold
    ) {
      console.log(
        `[ProxyPool] Active node ${this.activeNodeId} degraded (status: ${activeNode.status}, success rate: ${(activeNode.successRate * 100).toFixed(1)}%)`
      )
      const newNode = await this.selectBestProxy()
      if (newNode && newNode.id !== this.activeNodeId) {
        console.log(`[ProxyPool] Failing over to ${newNode.id}`)
        await this.switchProxy(newNode.id)
      }
    }
  }

  // ============================================
  // Proxy Selection
  // ============================================

  async selectBestProxy(regions?: string[]): Promise<ProxyNode | null> {
    const targetRegions = regions || this.config.preferredRegions
    const candidates: ProxyNode[] = []

    for (const node of this.nodes.values()) {
      if (node.status === 'down') continue

      // Prefer nodes in target regions
      if (targetRegions.length > 0 && node.region) {
        if (targetRegions.includes(node.region)) {
          candidates.push(node)
        }
      } else {
        candidates.push(node)
      }
    }

    // If no regional candidates, use all active nodes
    if (candidates.length === 0) {
      for (const node of this.nodes.values()) {
        if (node.status !== 'down') {
          candidates.push(node)
        }
      }
    }

    if (candidates.length === 0) return null

    // Sort by success rate (desc), then latency (asc)
    candidates.sort((a, b) => {
      const rateA = a.successRate || 0
      const rateB = b.successRate || 0
      if (Math.abs(rateA - rateB) > 0.1) {
        return rateB - rateA
      }
      return (a.avgLatency || 9999) - (b.avgLatency || 9999)
    })

    return candidates[0]
  }

  async switchProxy(nodeId: string): Promise<boolean> {
    const node = this.nodes.get(nodeId)
    if (!node) {
      logger.warn(`[ProxyPool] Node ${nodeId} not found`)
      return false
    }

    try {
      // Set the global proxy selector to use this node
      // This assumes a proxy group named "GLOBAL" or similar
      await this.clashRequest('/proxies/GLOBAL', {
        method: 'PUT',
        body: JSON.stringify({ name: nodeId }),
      })

      this.activeNodeId = nodeId
      console.log(`[ProxyPool] Switched to proxy: ${nodeId}`)
      return true
    } catch (err) {
      logger.error(`[ProxyPool] Failed to switch to ${nodeId}`, err instanceof Error ? err : new Error(String(err)))
      return false
    }
  }

  // ============================================
  // Request Tracking
  // ============================================

  recordRequest(nodeId: string, success: boolean): void {
    let stats = this.requestStats.get(nodeId)
    if (!stats) {
      stats = { success: 0, failed: 0 }
      this.requestStats.set(nodeId, stats)
    }

    if (success) {
      stats.success++
    } else {
      stats.failed++
    }
  }

  getActiveProxy(): ProxyNode | null {
    if (!this.activeNodeId) return null
    return this.nodes.get(this.activeNodeId) || null
  }

  getAllProxies(): ProxyNode[] {
    return Array.from(this.nodes.values())
  }

  getProxyStats(): {
    total: number
    active: number
    degraded: number
    down: number
    avgSuccessRate: number
  } {
    let active = 0
    let degraded = 0
    let down = 0
    let totalRate = 0

    for (const node of this.nodes.values()) {
      switch (node.status) {
        case 'active':
          active++
          break
        case 'degraded':
          degraded++
          break
        case 'down':
          down++
          break
      }
      totalRate += node.successRate
    }

    return {
      total: this.nodes.size,
      active,
      degraded,
      down,
      avgSuccessRate: this.nodes.size > 0 ? totalRate / this.nodes.size : 0,
    }
  }
}

export const proxyPool = new ProxyPoolManager()
