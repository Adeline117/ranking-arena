#!/usr/bin/env node
/**
 * cron-schedule-heatmap.mjs
 *
 * Reads vercel.json cron schedules, generates a 24h x 60min heatmap showing
 * how many crons fire at each minute slot, identifies collision windows,
 * and optionally writes an HTML report.
 *
 * Usage:
 *   node scripts/cron-schedule-heatmap.mjs           # text output only
 *   node scripts/cron-schedule-heatmap.mjs --html     # also write HTML report
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ---------- Cron expression parser (no external deps) ----------

/**
 * Parse a single cron field into an array of matching values.
 * Supports: *, N, N,M, N-M, * /step, N/step, N-M/step
 */
function parseCronField(field, min, max) {
  const values = new Set()

  for (const part of field.split(',')) {
    const [rangeStr, stepStr] = part.split('/')
    const step = stepStr ? parseInt(stepStr, 10) : 1

    let start, end
    if (rangeStr === '*') {
      start = min
      end = max
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map(Number)
      start = a
      end = b
    } else {
      start = parseInt(rangeStr, 10)
      end = start
    }

    for (let i = start; i <= end; i += step) {
      values.add(i)
    }
  }

  return [...values].sort((a, b) => a - b)
}

/**
 * Parse a cron expression (5 fields: min hour dom month dow)
 * and return all (hour, minute) pairs that fire within a generic day.
 * We ignore dom/month/dow for the heatmap — we only care about hourly patterns.
 */
function getCronFireTimes(schedule) {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return []

  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)

  const times = []
  for (const h of hours) {
    for (const m of minutes) {
      times.push({ hour: h, minute: m })
    }
  }
  return times
}

// ---------- Load data ----------

const vercelJson = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'))
const crons = vercelJson.crons || []

// 24x60 grid: heatmap[hour][minute] = count of crons firing
const heatmap = Array.from({ length: 24 }, () => new Array(60).fill(0))
// Also track which jobs fire at each slot
const jobsAt = Array.from({ length: 24 }, () =>
  Array.from({ length: 60 }, () => [])
)

for (const cron of crons) {
  const times = getCronFireTimes(cron.schedule)
  const label = cron.path.replace('/api/cron/', '')
  for (const { hour, minute } of times) {
    heatmap[hour][minute]++
    jobsAt[hour][minute].push(label)
  }
}

// ---------- Find collision windows (>=3 crons within a 5-minute window) ----------

function findCollisions(threshold = 3, windowMinutes = 5) {
  const collisions = []
  for (let h = 0; h < 24; h++) {
    for (let startMin = 0; startMin <= 60 - windowMinutes; startMin++) {
      let total = 0
      const jobs = new Set()
      for (let offset = 0; offset < windowMinutes; offset++) {
        total += heatmap[h][startMin + offset]
        for (const j of jobsAt[h][startMin + offset]) jobs.add(j)
      }
      if (total >= threshold) {
        collisions.push({
          hour: h,
          startMin,
          endMin: startMin + windowMinutes - 1,
          count: total,
          jobs: [...jobs],
        })
      }
    }
  }
  // De-duplicate overlapping windows: keep the one with highest count
  const deduped = []
  let prev = null
  for (const c of collisions) {
    if (prev && c.hour === prev.hour && c.startMin <= prev.endMin + 1) {
      // Overlapping — keep higher count
      if (c.count > prev.count) {
        deduped[deduped.length - 1] = c
        prev = c
      }
    } else {
      deduped.push(c)
      prev = c
    }
  }
  return deduped
}

// ---------- Text visualization ----------

function renderTextHeatmap() {
  const lines = []
  lines.push('')
  lines.push('='.repeat(80))
  lines.push('  CRON SCHEDULE HEATMAP — 24h x 60min (fires per minute slot)')
  lines.push('='.repeat(80))
  lines.push(`  Total cron jobs: ${crons.length}`)
  lines.push('')

  // Legend
  lines.push('  Legend: . = 0  1-2 = low  3-4 = MED  5+ = HIGH')
  lines.push('')

  // Header row — minute labels every 5
  let header = '       '
  for (let m = 0; m < 60; m++) {
    if (m % 10 === 0) header += String(m).padStart(2, ' ')
    else if (m % 5 === 0) header += String(m).padStart(2, ' ')
    else header += '  '
  }
  // Simplified: show tick marks at 0, 5, 10, ..., 55
  header = '       '
  for (let m = 0; m < 60; m += 5) {
    header += String(m).padStart(2, '0') + '   '
  }
  lines.push(header)

  const charFor = (n) => {
    if (n === 0) return '.'
    if (n <= 2) return String(n)
    if (n <= 4) return '#'
    return '@'
  }

  for (let h = 0; h < 24; h++) {
    let row = `  ${String(h).padStart(2, '0')}:00 `
    for (let m = 0; m < 60; m++) {
      row += charFor(heatmap[h][m])
    }

    // Summary: total fires this hour
    const hourTotal = heatmap[h].reduce((s, v) => s + v, 0)
    row += `  (${hourTotal})`
    lines.push(row)
  }

  lines.push('')
  lines.push('-'.repeat(80))

  // Collision report
  const collisions = findCollisions()
  lines.push('')
  lines.push(`  COLLISION WINDOWS (>=3 crons within 5-minute window): ${collisions.length} found`)
  lines.push('')

  if (collisions.length === 0) {
    lines.push('  No collision windows detected.')
  } else {
    for (const c of collisions) {
      lines.push(
        `  ${String(c.hour).padStart(2, '0')}:${String(c.startMin).padStart(2, '0')}-${String(c.hour).padStart(2, '0')}:${String(c.endMin).padStart(2, '0')}  ${c.count} crons: ${c.jobs.join(', ')}`
      )
    }
  }

  lines.push('')

  // Peak minutes (top 10)
  const allSlots = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      if (heatmap[h][m] > 0) {
        allSlots.push({ hour: h, minute: m, count: heatmap[h][m], jobs: jobsAt[h][m] })
      }
    }
  }
  allSlots.sort((a, b) => b.count - a.count)

  lines.push('  TOP 10 BUSIEST MINUTE SLOTS:')
  lines.push('')
  for (const s of allSlots.slice(0, 10)) {
    lines.push(
      `  ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}  ${s.count} crons: ${s.jobs.join(', ')}`
    )
  }
  lines.push('')
  lines.push('='.repeat(80))

  return lines.join('\n')
}

// ---------- HTML report ----------

function renderHtmlReport() {
  const collisions = findCollisions()
  const maxCount = Math.max(1, ...heatmap.flat())

  const colorFor = (n) => {
    if (n === 0) return '#1a1a2e'
    const intensity = Math.min(n / maxCount, 1)
    if (n <= 2) return `hsl(200, 70%, ${20 + intensity * 30}%)`
    if (n <= 4) return `hsl(40, 80%, ${30 + intensity * 30}%)`
    return `hsl(0, 80%, ${30 + intensity * 30}%)`
  }

  let cellsHtml = ''
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const count = heatmap[h][m]
      const jobs = jobsAt[h][m]
      const tooltip = count > 0
        ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} — ${count} cron(s):\n${jobs.join('\n')}`
        : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} — idle`
      cellsHtml += `<div class="cell" style="background:${colorFor(count)};grid-row:${h + 2};grid-column:${m + 2}" title="${tooltip.replace(/"/g, '&quot;')}">${count > 0 ? count : ''}</div>\n`
    }
  }

  // Hour labels
  let hourLabels = ''
  for (let h = 0; h < 24; h++) {
    hourLabels += `<div class="label-y" style="grid-row:${h + 2};grid-column:1">${String(h).padStart(2, '0')}:00</div>\n`
  }

  // Minute labels (every 5)
  let minuteLabels = ''
  for (let m = 0; m < 60; m += 5) {
    minuteLabels += `<div class="label-x" style="grid-row:1;grid-column:${m + 2}">:${String(m).padStart(2, '0')}</div>\n`
  }

  // Collision table
  let collisionRows = ''
  for (const c of collisions) {
    collisionRows += `<tr>
      <td>${String(c.hour).padStart(2, '0')}:${String(c.startMin).padStart(2, '0')}-${String(c.hour).padStart(2, '0')}:${String(c.endMin).padStart(2, '0')}</td>
      <td>${c.count}</td>
      <td>${c.jobs.map(j => `<code>${j}</code>`).join(', ')}</td>
    </tr>\n`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cron Schedule Heatmap — Arena</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: #888; margin-bottom: 24px; }
  .grid {
    display: grid;
    grid-template-columns: 60px repeat(60, 14px);
    grid-template-rows: 24px repeat(24, 18px);
    gap: 1px;
    margin-bottom: 32px;
    overflow-x: auto;
  }
  .cell {
    width: 14px; height: 18px;
    font-size: 9px; color: #fff;
    display: flex; align-items: center; justify-content: center;
    border-radius: 2px;
    cursor: pointer;
    transition: transform 0.1s;
  }
  .cell:hover { transform: scale(1.8); z-index: 10; position: relative; }
  .label-x { font-size: 10px; color: #888; display: flex; align-items: flex-end; justify-content: center; }
  .label-y { font-size: 11px; color: #888; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; }
  .legend { display: flex; gap: 12px; margin-bottom: 24px; font-size: 13px; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-swatch { width: 16px; height: 16px; border-radius: 3px; }
  h2 { font-size: 18px; margin: 24px 0 12px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #222; }
  th { color: #aaa; font-weight: 600; }
  code { background: #1a2a3a; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .stats { display: flex; gap: 32px; margin-bottom: 24px; }
  .stat { text-align: center; }
  .stat-value { font-size: 32px; font-weight: 700; color: #5cb8ff; }
  .stat-label { font-size: 12px; color: #888; }
</style>
</head>
<body>
<h1>Cron Schedule Heatmap</h1>
<p class="subtitle">Generated ${new Date().toISOString()} — ${crons.length} cron jobs from vercel.json</p>

<div class="stats">
  <div class="stat"><div class="stat-value">${crons.length}</div><div class="stat-label">Total Crons</div></div>
  <div class="stat"><div class="stat-value">${collisions.length}</div><div class="stat-label">Collision Windows</div></div>
  <div class="stat"><div class="stat-value">${maxCount}</div><div class="stat-label">Peak Concurrency</div></div>
</div>

<div class="legend">
  <div class="legend-item"><div class="legend-swatch" style="background:#1a1a2e"></div> 0 (idle)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:hsl(200,70%,35%)"></div> 1-2 (low)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:hsl(40,80%,45%)"></div> 3-4 (medium)</div>
  <div class="legend-item"><div class="legend-swatch" style="background:hsl(0,80%,45%)"></div> 5+ (high)</div>
</div>

<div class="grid">
  ${minuteLabels}
  ${hourLabels}
  ${cellsHtml}
</div>

<h2>Collision Windows (&ge;3 crons within 5-minute window)</h2>
${collisions.length === 0
    ? '<p style="color:#888">No collision windows detected.</p>'
    : `<table>
  <thead><tr><th>Window</th><th>Count</th><th>Jobs</th></tr></thead>
  <tbody>${collisionRows}</tbody>
</table>`
  }

<h2>All Cron Jobs</h2>
<table>
  <thead><tr><th>Schedule</th><th>Path</th><th>Fires/Day</th></tr></thead>
  <tbody>
    ${crons
      .map((c) => {
        const times = getCronFireTimes(c.schedule)
        return `<tr><td><code>${c.schedule}</code></td><td>${c.path.replace('/api/cron/', '')}</td><td>${times.length}</td></tr>`
      })
      .join('\n    ')}
  </tbody>
</table>
</body>
</html>`
}

// ---------- Main ----------

const text = renderTextHeatmap()
console.log(text)

const args = process.argv.slice(2)
if (args.includes('--html')) {
  const outputDir = join(__dirname, 'output')
  mkdirSync(outputDir, { recursive: true })
  const htmlPath = join(outputDir, 'cron-heatmap.html')
  writeFileSync(htmlPath, renderHtmlReport(), 'utf-8')
  console.log(`\n  HTML report written to: ${htmlPath}`)
}
