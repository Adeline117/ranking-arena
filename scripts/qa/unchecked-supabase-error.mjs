#!/usr/bin/env node
/**
 * 未检查的 Supabase 错误 — 棘轮门禁。
 *
 * 为什么：2026-06 起的修复提交里，最大的一类根因是"查询失败被当成空结果"：
 *   const { data } = await supabase.from('x').select('col')...
 * 一旦 col/表/RPC 在生产不存在（schema 漂移，PostgREST 42703/42P01/PGRST202）、
 * RLS 拒绝或网络失败，Supabase 不抛异常，只返回 { data: null, error }。
 * 只解构 data 的代码会把它当成"没找到/空列表/没权限"继续走，页面显示空态、
 * 按钮静默 500、计数显示 0——这就是 bug 反复回来的通道（详见
 * docs/BUG_RECURRENCE_2026-11.md）。
 *
 * 规则：在 app/ 与 lib/ 的运行时代码里，对一个包含 `.from(` / `.rpc(` 调用的
 * await 表达式做对象解构时，
 *   1. 解构里必须有 `error`；
 *   2. 解构出的 error 绑定必须在同一函数内被引用（解构了却不看也算吞）。
 * 只解构 `count` 同理。`.auth.*` / `.storage.*` 不在本门禁范围。
 *
 * 棘轮：存量问题按"文件 → 命中数"记在 unchecked-supabase-error-baseline.json。
 * 任何文件命中数超过基线（含新文件）直接失败；某文件命中数低于基线时也失败，
 * 要求同一 PR 用 `--update` 把基线降下来，保证清单只减不增。
 *
 * 纯本地 TypeScript AST 扫描：不访问网络、不读 env，几秒内完成。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const BASELINE_PATH = path.join(REPO, 'scripts/qa/unchecked-supabase-error-baseline.json')
const DIRS = ['app', 'lib']
const SOURCE_EXT_RE = /\.(?:ts|tsx|mts|cts)$/
const TEST_PATH_RE =
  /(?:^|\/)(?:__tests__|__mocks__|test|tests|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/
const QUERY_METHODS = new Set(['from', 'rpc'])
// `Array.from(..)` / `Buffer.from(..)` 等不是 Supabase 查询
const NON_SUPABASE_RECEIVERS = new Set(['Array', 'Buffer', 'Object', 'Uint8Array', 'Promise'])

function isQueryCall(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false
  const callee = unwrap(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || !QUERY_METHODS.has(callee.name.text)) return false
  const receiver = unwrap(callee.expression)
  return !(ts.isIdentifier(receiver) && NON_SUPABASE_RECEIVERS.has(receiver.text))
}
const RESULT_KEYS = new Set(['data', 'count'])

export function isTestFile(relativePath) {
  return TEST_PATH_RE.test(relativePath.replaceAll('\\', '/'))
}

function unwrap(node) {
  let current = node
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression?.(current))
  ) {
    current = current.expression
  }
  return current
}

/** 表达式子树里是否有 `<x>.from(...)` 或 `<x>.rpc(...)` 调用（不进入函数体）。 */
export function containsSupabaseQuery(node) {
  let found = false
  const visit = (child) => {
    if (found) return
    if (ts.isFunctionLike(child)) return
    if (isQueryCall(child)) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/**
 * 表达式本身就是一条 Supabase 查询链（`x.from(..)...` 或 `x.rpc(..)...`），
 * 而不是把查询当参数传给别的函数（如 `await withRetry(supabase.from(..))`、
 * `await Promise.all([...])`，那些由调用方负责）。
 */
export function isDirectQueryChain(node) {
  let current = unwrap(node)
  while (current) {
    if (ts.isCallExpression(current)) {
      if (isQueryCall(current)) return true
      const callee = unwrap(current.expression)
      current = ts.isPropertyAccessExpression(callee) ? callee.expression : null
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression
    } else {
      current =
        ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)
          ? current.expression
          : null
    }
  }
  return false
}

function propertyName(element) {
  const name = element.propertyName ?? element.name
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function enclosingScope(node) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current
    current = current.parent
  }
  return node.getSourceFile()
}

function isReferenced(bindingIdentifier) {
  const scope = enclosingScope(bindingIdentifier)
  const name = bindingIdentifier.text
  let referenced = false
  const visit = (child) => {
    if (referenced) return
    if (child !== bindingIdentifier && ts.isIdentifier(child) && child.text === name) {
      const parent = child.parent
      // obj.error 里的属性名、{ error: x } 的键不算引用
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === child) ||
        (ts.isPropertyAssignment(parent) && parent.name === child) ||
        (ts.isBindingElement(parent) && parent.propertyName === child)
      if (!isPropertyName) {
        referenced = true
        return
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(scope)
  return referenced
}

/** 扫描单个源文件，返回命中列表。 */
export function scanSource(source, file = 'app/example.ts') {
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const hits = []

  const record = (node, reason) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    hits.push({
      file,
      line: line + 1,
      column: character + 1,
      reason,
      text: node.getText(sf).split('\n')[0].slice(0, 120),
    })
  }

  const visit = (node) => {
    // `await supabase.from('x').insert(...)` 作为独立语句：结果整个被丢弃，error 永远没人看
    if (ts.isExpressionStatement(node)) {
      const expr = unwrap(node.expression)
      if (expr && ts.isAwaitExpression(expr) && isDirectQueryChain(expr.expression)) {
        record(node, 'discarded-result')
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const init = unwrap(node.initializer)
      if (init && ts.isAwaitExpression(init) && containsSupabaseQuery(init.expression)) {
        const elements = node.name.elements
        const hasRest = elements.some((element) => element.dotDotDotToken)
        const keys = elements.map(propertyName)
        const takesResult = keys.some((key) => key && RESULT_KEYS.has(key))
        const errorElement = elements.find((element) => propertyName(element) === 'error')
        if (takesResult && !hasRest) {
          if (!errorElement) {
            record(node, 'missing-error')
          } else if (ts.isIdentifier(errorElement.name) && !isReferenced(errorElement.name)) {
            record(node, 'unused-error')
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) out.push(full)
  }
  return out
}

export function scanRepo(repo = REPO) {
  const counts = {}
  const hits = []
  for (const dir of DIRS) {
    for (const full of walk(path.join(repo, dir), [])) {
      const rel = path.relative(repo, full).replaceAll('\\', '/')
      if (isTestFile(rel)) continue
      const source = fs.readFileSync(full, 'utf8')
      if (!/\.(?:from|rpc)\s*\(/.test(source)) continue
      const fileHits = scanSource(source, rel)
      if (fileHits.length > 0) {
        counts[rel] = fileHits.length
        hits.push(...fileHits)
      }
    }
  }
  return { counts: sortObject(counts), hits }
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)))
}

/** 对比当前命中与基线：增多/新增 = 回归；减少 = 基线过期（必须同步降低）。 */
export function evaluate(counts, baseline) {
  const regressions = []
  const stale = []
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) regressions.push({ file, count, allowed })
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!Number.isInteger(allowed) || allowed <= 0) {
      throw new Error(`基线条目无效：${file} = ${String(allowed)}`)
    }
    const count = counts[file] ?? 0
    if (count < allowed) stale.push({ file, count, allowed })
  }
  return { ok: regressions.length === 0 && stale.length === 0, regressions, stale }
}

export function readBaseline(file = BASELINE_PATH) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed.files !== 'object') throw new Error('基线缺少 files 字段')
  return parsed.files
}

/** --update 只允许降低：任何文件计数高于现有基线时拒绝写入。 */
export function buildUpdatedBaseline(counts, baseline) {
  const grown = Object.entries(counts).filter(([file, count]) => count > (baseline[file] ?? 0))
  if (grown.length > 0) {
    const list = grown.map(([file, count]) => `${file} (${baseline[file] ?? 0} → ${count})`)
    throw new Error(`拒绝放大基线：${list.join(', ')}`)
  }
  return sortObject(counts)
}

/** 基线相对基准提交被放宽的条目（新增文件或允许数变大）。 */
export function findWidened(baseline, baseBaseline) {
  return Object.entries(baseline)
    .filter(([file, allowed]) => allowed > (baseBaseline[file] ?? 0))
    .map(([file, allowed]) => ({ file, allowed, base: baseBaseline[file] ?? 0 }))
}

/** 读取基准提交里的基线；该提交还没有这个文件（门禁首次引入）时返回 null。 */
function readBaselineAtRef(ref, repo) {
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) throw new Error(`基准提交格式无效：${ref}`)
  const rel = 'scripts/qa/unchecked-supabase-error-baseline.json'
  const result = spawnSync('git', ['show', `${ref}:${rel}`], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const stderr = result.stderr ?? ''
    if (/does not exist|exists on disk, but not in/.test(stderr)) return null
    if (/invalid object name|bad object|unknown revision|bad revision/i.test(stderr)) {
      // 强推后 push 事件的 before 可能已不在历史里：跳过比较但留痕
      console.warn(`⚠️  基准提交 ${ref} 不在本地历史，跳过基线放宽比较`)
      return null
    }
    throw new Error(
      `无法读取基准提交 ${ref} 的基线：${(result.stderr || result.error?.message || '').trim()}`
    )
  }
  const parsed = JSON.parse(result.stdout)
  return parsed.files ?? {}
}

function writeBaseline(files, file = BASELINE_PATH) {
  const total = Object.values(files).reduce((sum, n) => sum + n, 0)
  const body = {
    $comment:
      '未检查 Supabase 错误的存量清单（scripts/qa/unchecked-supabase-error.mjs）。只许减少：修掉后运行 `npm run qa:unchecked-supabase-error -- --update`。',
    total,
    files,
  }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
}

export function runCli(argv = process.argv.slice(2), repo = REPO) {
  const started = Date.now()
  const { counts, hits } = scanRepo(repo)
  const baselineFile = path.join(repo, 'scripts/qa/unchecked-supabase-error-baseline.json')

  const baseline = readBaseline(baselineFile)

  // 防手改放大：CI 传入基准提交，提交的基线不得比基准提交里的基线宽
  const baseRef = process.env.UNCHECKED_SUPABASE_ERROR_BASE_REF?.trim()
  if (baseRef && !argv.includes('--update')) {
    const baseBaseline = readBaselineAtRef(baseRef, repo)
    if (baseBaseline) {
      const widened = findWidened(baseline, baseBaseline)
      if (widened.length > 0) {
        console.error('\n❌ 基线被放大（只许减少）：')
        for (const { file, allowed, base } of widened) {
          console.error(`   ${file}: ${base} → ${allowed}`)
        }
        return 1
      }
    }
  }

  if (argv.includes('--update')) {
    try {
      writeBaseline(buildUpdatedBaseline(counts, baseline), baselineFile)
    } catch (error) {
      console.error(`❌ ${error.message}`)
      return 1
    }
    console.log('✅ 基线已按当前命中数降低')
    return 0
  }

  const result = evaluate(counts, baseline)
  const total = hits.length
  const elapsed = Date.now() - started

  if (result.regressions.length > 0) {
    console.error('\n❌ 新增了未检查 error 的 Supabase 查询（失败会被当成空结果静默吞掉）：')
    for (const { file, count, allowed } of result.regressions) {
      console.error(`   ${file}: ${count} > 允许 ${allowed}`)
      for (const hit of hits.filter((h) => h.file === file).slice(0, 8)) {
        console.error(`     ${hit.file}:${hit.line}:${hit.column} [${hit.reason}] ${hit.text}`)
      }
    }
    console.error(
      '\n   修法：解构 `{ data, error }` 并处理 error（logger.error / 抛出 / 返回错误态），' +
        '不要把失败当成"没有数据"。'
    )
  }
  if (result.stale.length > 0) {
    console.error('\n❌ 基线过期（有文件已修好，清单必须同步缩小）：')
    for (const { file, count, allowed } of result.stale) {
      console.error(`   ${file}: 现在 ${count} < 基线 ${allowed}`)
    }
    console.error('\n   运行 `npm run qa:unchecked-supabase-error -- --update` 并提交基线文件。')
  }
  if (result.ok) {
    console.log(`✅ 未检查 Supabase 错误棘轮通过：${total} 处存量（基线内），耗时 ${elapsed}ms`)
    return 0
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli()
}
