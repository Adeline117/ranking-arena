#!/usr/bin/env node

/**
 * VPS Healthcheck Endpoint
 * 部署到 VPS (45.76.152.169) 的 /opt/arena/healthcheck.mjs
 * 提供 JSON 健康状态供 UptimeRobot 监控
 *
 * 用法: node healthcheck.mjs
 * 默认端口: 3333
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'

const PORT = parseInt(process.env.HEALTHCHECK_PORT || '3333')

// 检查的脚本日志路径 (根据实际VPS配置调整)
const SCRIPT_LOGS = {
  'scrape-bingx': '/opt/arena/logs/scrape-bingx.log',
  'import-binance': '/opt/arena/logs/import-binance.log',
  'refresh-all': '/opt/arena/logs/refresh-all.log',
}

function getLastModified(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return stat.mtime.toISOString()
  } catch {
    return null
  }
}

function getDiskUsage() {
  try {
    const output = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: 'utf8' }).trim()
    return output
  } catch {
    return 'unknown'
  }
}

function getHealthStatus() {
  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const memUsedPct = Math.round((1 - memFree / memTotal) * 100)

  const scripts = {}
  for (const [name, logPath] of Object.entries(SCRIPT_LOGS)) {
    scripts[name] = {
      lastRun: getLastModified(logPath),
      logPath,
    }
  }

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(os.uptime()),
    hostname: os.hostname(),
    memory: {
      totalMB: Math.round(memTotal / 1024 / 1024),
      freeMB: Math.round(memFree / 1024 / 1024),
      usedPct: memUsedPct,
    },
    disk: getDiskUsage(),
    scripts,
    loadAvg: os.loadavg().map(l => Math.round(l * 100) / 100),
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    const health = getHealthStatus()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(health, null, 2))
  } else {
    res.writeHead(404)
    res.end('Not Found')
  }
})

server.listen(PORT, () => {
  console.log(`Healthcheck server running on port ${PORT}`)
})
