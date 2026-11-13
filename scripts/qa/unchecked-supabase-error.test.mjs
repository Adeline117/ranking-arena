import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildUpdatedBaseline,
  evaluate,
  findWidened,
  isTestFile,
  readBaseline,
  runCli,
  scanRepo,
  scanSource,
} from './unchecked-supabase-error.mjs'

const reasons = (source, file) => scanSource(source, file).map((hit) => hit.reason)

// ── 正例：必须拦下 ──────────────────────────────────────────────

test('只解构 data、不取 error 的查询被拦下（a86854667 修复前的群管理鉴权写法）', () => {
  const source = `
    export async function isAdmin(supabase, groupId, userId) {
      const { data: member } = await supabase
        .from('group_members')
        .select('role')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .maybeSingle()
      return member?.role === 'admin'
    }
  `
  assert.deepEqual(reasons(source), ['missing-error'])
})

test('rpc 与 schema().from() 链、只取 count 同样被拦下', () => {
  const source = `
    async function f(db) {
      const { data } = await db.rpc('get_rank', { id: 1 })
      const { count } = await db.schema('arena').from('traders').select('*', { count: 'exact', head: true })
      const { data: raced } = await Promise.race([db.from('t').select('a'), timeout()])
      return [data, count, raced]
    }
  `
  assert.deepEqual(reasons(source), ['missing-error', 'missing-error', 'missing-error'])
})

test('解构了 error 却从未引用，也算吞错', () => {
  const source = `
    async function f(db) {
      const { data, error } = await db.from('posts').select('id')
      return data ?? []
    }
    async function g(db) {
      const { data, error: loadError } = await db.from('posts').select('id')
      return { data, error: null, loadError: undefined }.data
    }
  `
  assert.deepEqual(reasons(source), ['unused-error', 'unused-error'])
})

test('写操作结果整个丢弃被拦下（c389e9e93 修复前的 admin_logs 写法）', () => {
  const source = `
    async function audit(supabase, row) {
      await supabase.from('admin_logs').insert(row)
      await (supabase.from('posts').delete().eq('id', 1))
      await supabase.rpc('increment_like_count', { post_id: 1 })
    }
  `
  assert.deepEqual(reasons(source), ['discarded-result', 'discarded-result', 'discarded-result'])
})

test('命中记录给出文件、行号与原因', () => {
  const [hit] = scanSource("\nconst { data } = await sb.from('x').select('a')\n", 'lib/x.ts')
  assert.equal(hit.file, 'lib/x.ts')
  assert.equal(hit.line, 2)
  assert.equal(hit.reason, 'missing-error')
})

// ── 反例：不得误报 ──────────────────────────────────────────────

test('解构并使用 error 的查询放行（含改名、在嵌套回调里使用）', () => {
  const source = `
    async function f(db) {
      const { data, error } = await db.from('posts').select('id')
      if (error) throw error
      const { data: rows, error: rowsError } = await db.rpc('fn', {})
      queueMicrotask(() => { if (rowsError) log(rowsError) })
      return [data, rows]
    }
  `
  assert.deepEqual(reasons(source), [])
})

test('保留整个结果对象、rest 解构、非 await、非 Supabase 调用都放行', () => {
  const source = `
    async function f(db, api) {
      const result = await db.from('posts').select('id')
      const { data, ...rest } = await db.from('posts').select('id')
      const { data: arr } = await api.get(Array.from(ids))
      const { data: buf } = await upload(Buffer.from('x'))
      const { data: session } = await db.auth.getSession()
      const query = db.from('posts').select('id')
      const { data: inner } = await withTimeout(async () => db.from('x').select('a'))
      await withRetry(db.from('posts').insert({}))
      await Promise.all([db.from('a').insert({})])
      return [result, data, rest, arr, buf, session, query, inner]
    }
  `
  assert.deepEqual(reasons(source), [])
})

test('属性名里的 error 不算对 error 绑定的引用', () => {
  const source = `
    async function f(db) {
      const { data, error } = await db.from('posts').select('id')
      return { error: data, other: obj.error }
    }
  `
  assert.deepEqual(reasons(source), ['unused-error'])
})

test('测试与类型声明文件不计入运行时', () => {
  assert.equal(isTestFile('app/api/x/__tests__/route.test.ts'), true)
  assert.equal(isTestFile('lib/foo.spec.tsx'), true)
  assert.equal(isTestFile('lib/types/supabase.d.ts'), true)
  assert.equal(isTestFile('app/api/x/route.ts'), false)
})

// ── 棘轮语义 ────────────────────────────────────────────────────

test('新文件或命中数增加 = 回归；减少 = 基线过期；持平通过', () => {
  const baseline = { 'app/a.ts': 2, 'lib/b.ts': 1 }
  assert.equal(evaluate({ 'app/a.ts': 2, 'lib/b.ts': 1 }, baseline).ok, true)

  const grown = evaluate({ 'app/a.ts': 3, 'lib/b.ts': 1, 'lib/new.ts': 1 }, baseline)
  assert.equal(grown.ok, false)
  assert.deepEqual(
    grown.regressions.map((r) => r.file),
    ['app/a.ts', 'lib/new.ts']
  )

  const shrunk = evaluate({ 'app/a.ts': 1 }, baseline)
  assert.equal(shrunk.ok, false)
  assert.deepEqual(
    shrunk.stale.map((s) => [s.file, s.count]),
    [
      ['app/a.ts', 1],
      ['lib/b.ts', 0],
    ]
  )
})

test('--update 只许降低基线，拒绝放大', () => {
  assert.deepEqual(buildUpdatedBaseline({ 'app/a.ts': 1 }, { 'app/a.ts': 2, 'lib/b.ts': 1 }), {
    'app/a.ts': 1,
  })
  assert.throws(() => buildUpdatedBaseline({ 'app/a.ts': 3 }, { 'app/a.ts': 2 }), /拒绝放大基线/)
  assert.throws(() => buildUpdatedBaseline({ 'lib/new.ts': 1 }, {}), /拒绝放大基线/)
})

test('相对基准提交新增条目或放大允许数都算放宽', () => {
  const base = { 'app/a.ts': 2 }
  assert.deepEqual(findWidened({ 'app/a.ts': 2 }, base), [])
  assert.deepEqual(findWidened({ 'app/a.ts': 1 }, base), [])
  assert.deepEqual(
    findWidened({ 'app/a.ts': 3, 'lib/new.ts': 1 }, base).map((w) => w.file),
    ['app/a.ts', 'lib/new.ts']
  )
})

test('基线里 0 或非整数条目视为无效', () => {
  assert.throws(() => evaluate({}, { 'app/a.ts': 0 }), /基线条目无效/)
})

test('端到端：临时仓库里新增未检查查询会让 CLI 失败，修好后 --update 收紧基线', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unchecked-supabase-error-'))
  try {
    fs.mkdirSync(path.join(repo, 'app/api/x'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'lib'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'scripts/qa'), { recursive: true })
    const baselineFile = path.join(repo, 'scripts/qa/unchecked-supabase-error-baseline.json')
    const route = path.join(repo, 'app/api/x/route.ts')
    fs.writeFileSync(
      route,
      "export async function GET(db) { const { data } = await db.from('t').select('a'); return data }\n"
    )
    fs.writeFileSync(baselineFile, JSON.stringify({ files: { 'app/api/x/route.ts': 1 } }))

    const silence = (fn) => {
      const { log, error } = console
      console.log = () => {}
      console.error = () => {}
      try {
        return fn()
      } finally {
        console.log = log
        console.error = error
      }
    }

    assert.equal(
      silence(() => runCli([], repo)),
      0
    )

    fs.writeFileSync(
      path.join(repo, 'lib/new.ts'),
      "export async function f(db) { await db.from('t').insert({}) }\n"
    )
    assert.equal(
      silence(() => runCli([], repo)),
      1
    )
    assert.equal(
      silence(() => runCli(['--update'], repo)),
      1,
      '不能用 --update 洗白新增'
    )
    fs.rmSync(path.join(repo, 'lib/new.ts'))

    fs.writeFileSync(
      route,
      "export async function GET(db) { const { data, error } = await db.from('t').select('a'); if (error) throw error; return data }\n"
    )
    assert.equal(
      silence(() => runCli([], repo)),
      1,
      '修好后基线过期也要失败'
    )
    assert.equal(
      silence(() => runCli(['--update'], repo)),
      0
    )
    assert.deepEqual(readBaseline(baselineFile), {})
    assert.equal(
      silence(() => runCli([], repo)),
      0
    )
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('仓库当前状态与提交的基线一致，且扫描在 10 秒内完成', () => {
  const started = Date.now()
  const { counts } = scanRepo()
  const elapsed = Date.now() - started
  const result = evaluate(counts, readBaseline())
  assert.deepEqual(result.regressions, [])
  assert.deepEqual(result.stale, [])
  assert.ok(elapsed < 10_000, `扫描耗时 ${elapsed}ms`)
})
