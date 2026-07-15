#!/usr/bin/env node
/**
 * Full group-application lifecycle acceptance (owner-run).
 *
 * This is deliberately not a service-role imitation of the approval route.
 * It requires a fresh access token from a real user whose email is in
 * ADMIN_EMAILS, verifies that token against the actual admin list endpoint
 * before any mutation, then exercises:
 *
 *   QA-A application -> real admin approval -> QA-B joins -> QA-B group post
 *   -> QA-A dissolves -> exact QA-only cleanup + service-role read-back.
 *
 * Run (the token must never be committed or printed):
 *   ADMIN_ACCESS_TOKEN=<fresh allowlisted-admin JWT> \
 *     node scripts/qa/group-admin-lifecycle.mjs
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is used only for narrowly scoped cleanup and
 * final read-backs. All product operations use their normal HTTP endpoints.
 */
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { ACCOUNT_A, ACCOUNT_B, loginQa, qaAuthStatus, readEnv } from './qa-auth.mjs'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const ADMIN_ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN
const RUN = `qa-group-lifecycle-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
const results = []
const cleanupFailures = []

function note(message) {
  results.push(message)
  process.stdout.write(`${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  // Do not even authenticate QA accounts until the only external prerequisite
  // is present. That makes a missing owner token a true zero-write exit.
  if (!ADMIN_ACCESS_TOKEN) {
    throw new Error('ADMIN_ACCESS_TOKEN is required; refusing to start any write flow')
  }

  const supaUrl = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const srk = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  const [aSession, bSession] = await Promise.all([
    loginQa({ supaUrl, anon, srk, account: ACCOUNT_A }),
    loginQa({ supaUrl, anon, srk, account: ACCOUNT_B }),
  ])
  assert(aSession.user?.id === ACCOUNT_A.userId, 'QA-A session resolved to an unexpected account')
  assert(bSession.user?.id === ACCOUNT_B.userId, 'QA-B session resolved to an unexpected account')
  assert(
    (await qaAuthStatus(supaUrl, anon, aSession.access_token)) === 200 &&
      (await qaAuthStatus(supaUrl, anon, bSession.access_token)) === 200,
    'QA account preflight failed'
  )

  const csrf = `${Date.now().toString(36)}.${crypto.randomBytes(32).toString('hex')}`
  const host = new URL(BASE).hostname
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addCookies([
    {
      name: 'csrf-token',
      value: csrf,
      domain: host === 'localhost' ? 'localhost' : '.arenafi.org',
      path: '/',
    },
  ])
  const page = await context.newPage()
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  const call = (token, path, init = {}) =>
    page.evaluate(
      async ({ target, requestInit, accessToken, csrfToken }) => {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'x-csrf-token': csrfToken,
          ...(requestInit.headers || {}),
        }
        const res = await fetch(target, { ...requestInit, headers })
        const text = await res.text()
        let body = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = { raw: text.slice(0, 300) }
        }
        return { status: res.status, body }
      },
      { target: path, requestInit: init, accessToken: token, csrfToken: csrf }
    )

  const rest = async (table, query, init = {}) => {
    const res = await fetch(`${supaUrl}/rest/v1/${table}?${query}`, {
      ...init,
      headers: {
        apikey: srk,
        Authorization: `Bearer ${srk}`,
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    })
    if (!res.ok) throw new Error(`service cleanup/read ${table} returned ${res.status}`)
    return res.status === 204 ? [] : res.json()
  }

  const listNotificationIds = async (userId) =>
    new Set(
      (
        await rest(
          'notifications',
          new URLSearchParams({ select: 'id', user_id: `eq.${userId}`, limit: '100' }).toString()
        )
      ).map((row) => row.id)
    )

  let applicationId = null
  let groupId = null
  let postId = null
  const newNotificationIds = { a: new Set(), b: new Set() }

  const deleteById = async (table, id, extra = {}) => {
    const query = new URLSearchParams({ id: `eq.${id}`, ...extra }).toString()
    return rest(table, query, { method: 'DELETE' })
  }

  try {
    // This is the crucial real-admin check. A profile role alone is not enough:
    // the route also enforces ADMIN_EMAILS through verifyAdmin().
    const adminPreflight = await call(
      ADMIN_ACCESS_TOKEN,
      '/api/groups/applications?status=pending',
      {
        method: 'GET',
      }
    )
    assert(
      adminPreflight.status === 200 && Array.isArray(adminPreflight.body?.applications),
      `admin token is not allowlisted by the live route (${adminPreflight.status})`
    )
    note('OK allowlisted admin preflight')

    const [aNotificationsBefore, bNotificationsBefore] = await Promise.all([
      listNotificationIds(ACCOUNT_A.userId),
      listNotificationIds(ACCOUNT_B.userId),
    ])

    const application = await call(aSession.access_token, '/api/groups/apply', {
      method: 'POST',
      body: JSON.stringify({
        name: `[QA] ${RUN.slice(-24)}`,
        description: `[${RUN}] QA-only lifecycle canary; dissolved and removed by this run.`,
      }),
    })
    applicationId = application.body?.application?.id || null
    assert(
      application.status < 300 && applicationId,
      `application submit failed (${application.status})`
    )

    const pending = await call(aSession.access_token, '/api/groups/apply', { method: 'GET' })
    assert(
      pending.body?.applications?.some(
        (row) => row.id === applicationId && row.status === 'pending'
      ),
      'applicant GET read-back missed pending application'
    )
    note(`OK pending application persisted: ${applicationId}`)

    const approved = await call(
      ADMIN_ACCESS_TOKEN,
      `/api/groups/applications/${encodeURIComponent(applicationId)}/approve`,
      { method: 'POST', body: '{}' }
    )
    groupId = approved.body?.group?.id || null
    assert(approved.status < 300 && groupId, `live admin approval failed (${approved.status})`)
    note(`OK live admin approval created group: ${groupId}`)

    const applicationAfter = await call(aSession.access_token, '/api/groups/apply', {
      method: 'GET',
    })
    assert(
      applicationAfter.body?.applications?.some(
        (row) => row.id === applicationId && row.status === 'approved' && row.group_id === groupId
      ),
      'applicant GET read-back missed approved group link'
    )
    const groups = await rest(
      'groups',
      new URLSearchParams({ select: 'id,created_by,dissolved_at', id: `eq.${groupId}` }).toString()
    )
    assert(
      groups.length === 1 && groups[0].created_by === ACCOUNT_A.userId && !groups[0].dissolved_at,
      'approved group read-back is not QA-A-owned and active'
    )

    const joined = await call(bSession.access_token, `/api/groups/${groupId}/membership`, {
      method: 'POST',
      body: JSON.stringify({ action: 'join' }),
    })
    assert(
      joined.status < 300 && joined.body?.action === 'joined',
      `QA-B join failed (${joined.status})`
    )
    const membership = await rest(
      'group_members',
      new URLSearchParams({
        select: 'group_id,user_id,role',
        group_id: `eq.${groupId}`,
        user_id: `eq.${ACCOUNT_B.userId}`,
      }).toString()
    )
    assert(
      membership.length === 1 && membership[0].role === 'member',
      'QA-B membership read-back failed'
    )
    note('OK QA-B group membership persisted')

    const groupPost = await call(bSession.access_token, '/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: `[${RUN}] group post`,
        content: `[${RUN}] QA-only group lifecycle post; deleted by this same run.`,
        group_id: groupId,
      }),
    })
    postId = groupPost.body?.data?.post?.id || groupPost.body?.data?.id || null
    assert(groupPost.status === 201 && postId, `group post create failed (${groupPost.status})`)
    const groupFeed = await call(
      bSession.access_token,
      `/api/posts?group_id=${encodeURIComponent(groupId)}`,
      {
        method: 'GET',
      }
    )
    const feedRows = groupFeed.body?.data?.posts || groupFeed.body?.posts || []
    assert(
      feedRows.some((row) => row.id === postId),
      'group feed read-back missed QA-B post'
    )
    note(`OK QA-B group post persisted: ${postId}`)

    const deletedPost = await call(bSession.access_token, `/api/posts/${postId}`, {
      method: 'DELETE',
    })
    assert(deletedPost.status < 300, `QA-B group post deletion failed (${deletedPost.status})`)
    const postAfterDelete = await rest(
      'posts',
      new URLSearchParams({ select: 'id,deleted_at', id: `eq.${postId}` }).toString()
    )
    assert(
      postAfterDelete.length === 1 && postAfterDelete[0].deleted_at,
      'post deletion read-back failed'
    )
    note('OK QA-B group post soft-deleted')

    const dissolved = await call(aSession.access_token, `/api/groups/${groupId}/dissolve`, {
      method: 'POST',
      body: '{}',
    })
    assert(
      dissolved.status < 300 && dissolved.body?.success === true,
      `group dissolution failed (${dissolved.status})`
    )
    const dissolvedRows = await rest(
      'groups',
      new URLSearchParams({ select: 'id,dissolved_at', id: `eq.${groupId}` }).toString()
    )
    assert(
      dissolvedRows.length === 1 && dissolvedRows[0].dissolved_at,
      'dissolution read-back failed'
    )
    note('OK QA-A dissolved QA group')

    const [aNotificationsAfter, bNotificationsAfter] = await Promise.all([
      listNotificationIds(ACCOUNT_A.userId),
      listNotificationIds(ACCOUNT_B.userId),
    ])
    for (const id of aNotificationsAfter)
      if (!aNotificationsBefore.has(id)) newNotificationIds.a.add(id)
    for (const id of bNotificationsAfter)
      if (!bNotificationsBefore.has(id)) newNotificationIds.b.add(id)
  } finally {
    // Product deletes first. The subsequent service-role cleanup is an exact,
    // QA-owned last resort because the product intentionally has no "delete
    // dissolved group" endpoint. It can never match a real user or group.
    if (postId) {
      try {
        await deleteById('posts', postId, {
          author_id: `eq.${ACCOUNT_B.userId}`,
          group_id: `eq.${groupId}`,
        })
      } catch (error) {
        cleanupFailures.push(`post:${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (applicationId) {
      try {
        await deleteById('group_applications', applicationId, {
          applicant_id: `eq.${ACCOUNT_A.userId}`,
        })
      } catch (error) {
        cleanupFailures.push(
          `application:${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    if (groupId) {
      try {
        await rest(
          'group_members',
          new URLSearchParams({
            group_id: `eq.${groupId}`,
            user_id: `in.(${ACCOUNT_A.userId},${ACCOUNT_B.userId})`,
          }).toString(),
          { method: 'DELETE' }
        )
        await rest(
          'groups',
          new URLSearchParams({
            id: `eq.${groupId}`,
            created_by: `eq.${ACCOUNT_A.userId}`,
            dissolved_at: 'not.is.null',
          }).toString(),
          { method: 'DELETE' }
        )
      } catch (error) {
        cleanupFailures.push(`group:${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const [account, ids] of Object.entries(newNotificationIds)) {
      const session = account === 'a' ? aSession : bSession
      for (const id of ids) {
        try {
          const removed = await call(session.access_token, `/api/notifications/${id}`, {
            method: 'DELETE',
          })
          if (removed.status >= 300 && removed.status !== 404) {
            throw new Error(`notification delete returned ${removed.status}`)
          }
        } catch (error) {
          cleanupFailures.push(
            `notification:${id}:${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
    await browser.close()
  }

  assert(cleanupFailures.length === 0, `cleanup failures: ${cleanupFailures.join('; ')}`)
  const residual = await Promise.all([
    groupId
      ? rest('groups', new URLSearchParams({ select: 'id', id: `eq.${groupId}` }).toString())
      : [],
    applicationId
      ? rest(
          'group_applications',
          new URLSearchParams({ select: 'id', id: `eq.${applicationId}` }).toString()
        )
      : [],
    postId
      ? rest('posts', new URLSearchParams({ select: 'id', id: `eq.${postId}` }).toString())
      : [],
  ])
  assert(
    residual.every((rows) => rows.length === 0),
    'QA lifecycle left a database residue'
  )
  process.stdout.write(`${JSON.stringify({ pass: true, run: RUN, results, cleanupFailures })}\n`)
}

main().catch((error) => {
  console.error(
    `FAIL group lifecycle acceptance: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})
