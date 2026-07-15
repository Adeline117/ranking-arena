#!/usr/bin/env node
/**
 * Controlled QA-A ↔ QA-B write-flow acceptance.
 *
 * Unlike auth-button-sweep, this script never targets a real trader or user.
 * It verifies the user-to-user write paths on production using only the two
 * dedicated QA accounts, then reverses every mutation in finally. Objects are
 * marked with a per-run token so cleanup can never delete unrelated QA data.
 *
 * Covers plan B2/B3's highest-risk chain and the safe B4 pre-approval edge:
 *   QA-B followers-only post → QA-A follow + comment → notification in B's
 *   inbox → GET read-backs → comment/follow/post/notification cleanup;
 *   QA-A group application → applicant GET read-back → exact pending cleanup.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { ACCOUNT_A, ACCOUNT_B, loginQa, qaAuthStatus, readEnv } from './qa-auth.mjs'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const RUN = `qa-controlled-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
const results = []
const cleanupFailures = []
const RESULT_FILE = process.env.QA_RESULT_FILE

function note(message) {
  results.push(message)
  process.stdout.write(`${message}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function persistResult(status, error = null) {
  if (!RESULT_FILE) return
  fs.writeFileSync(
    RESULT_FILE,
    JSON.stringify({ status, run: RUN, error, results, cleanupFailures }, null, 2) + '\n',
    { mode: 0o600 }
  )
}

async function main() {
  const supaUrl = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const anon = readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  const srk = readEnv('SUPABASE_SERVICE_ROLE_KEY')

  // loginQa serializes its one-time password-reset fallback. It only ever
  // resets the explicitly selected QA account, never a real-user credential.
  const [aSession, bSession] = await Promise.all([
    loginQa({ supaUrl, anon, srk, account: ACCOUNT_A }),
    loginQa({ supaUrl, anon, srk, account: ACCOUNT_B }),
  ])
  assert(aSession.user?.id === ACCOUNT_A.userId, 'QA-A session resolved to an unexpected account')
  assert(bSession.user?.id === ACCOUNT_B.userId, 'QA-B session resolved to an unexpected account')
  assert(
    (await qaAuthStatus(supaUrl, anon, aSession.access_token)) === 200 &&
      (await qaAuthStatus(supaUrl, anon, bSession.access_token)) === 200,
    'QA session preflight failed'
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

  const call = (session, path, init = {}) =>
    page.evaluate(
      async ({ path: target, init: requestInit, token, csrfToken }) => {
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
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
      { path, init, token: session.access_token, csrfToken: csrf }
    )

  // A group application has no applicant-facing DELETE endpoint. Cleanup uses
  // service role only for this exact QA-owned, still-pending row; the status
  // predicate deliberately refuses to touch an application that an admin has
  // already reviewed or a group that may have been created from it.
  const deletePendingQaApplication = async (applicationId) => {
    const params = new URLSearchParams({
      id: `eq.${applicationId}`,
      applicant_id: `eq.${ACCOUNT_A.userId}`,
      status: 'eq.pending',
    })
    const res = await fetch(`${supaUrl}/rest/v1/group_applications?${params}`, {
      method: 'DELETE',
      headers: {
        apikey: srk,
        Authorization: `Bearer ${srk}`,
        Prefer: 'return=representation',
      },
    })
    if (!res.ok) throw new Error(`pending application cleanup returned ${res.status}`)
    const deleted = await res.json()
    assert(
      Array.isArray(deleted) && deleted.some((row) => row.id === applicationId),
      'pending application was not deleted'
    )
  }

  const listNotifications = async (userId) => {
    const params = new URLSearchParams({
      select: 'id,type,actor_id,reference_id',
      user_id: `eq.${userId}`,
      order: 'created_at.desc',
      limit: '100',
    })
    const res = await fetch(`${supaUrl}/rest/v1/notifications?${params}`, {
      headers: { apikey: srk, Authorization: `Bearer ${srk}` },
    })
    if (!res.ok) throw new Error(`notification read-back returned ${res.status}`)
    return res.json()
  }

  let postId = null
  let commentId = null
  let replyId = null
  let groupApplicationId = null
  let followedByRun = false
  const notificationsToClean = []

  const flattenComments = (rows) =>
    rows.flatMap((comment) => [comment, ...(Array.isArray(comment.replies) ? comment.replies : [])])

  try {
    // Never remove a pre-existing relationship: a dirty QA baseline must be
    // repaired by a human rather than risking deletion of meaningful test data.
    const followBefore = await call(
      aSession,
      `/api/users/follow?followingId=${encodeURIComponent(ACCOUNT_B.userId)}`,
      { method: 'GET' }
    )
    assert(followBefore.status === 200, `follow preflight returned ${followBefore.status}`)
    assert(
      followBefore.body?.following !== true,
      'QA-A already follows QA-B; refusing to alter baseline'
    )

    // The user-facing notification list caches for 30s. Use the service-role
    // read path only to establish a precise QA-only DB baseline; notification
    // creation still goes through normal user API actions and deletion later
    // goes through the normal user notification endpoint.
    const inboxBefore = async (userId) =>
      new Set((await listNotifications(userId)).map((n) => n.id))
    const [aNotificationsBefore, bNotificationsBefore] = await Promise.all([
      inboxBefore(ACCOUNT_A.userId),
      inboxBefore(ACCOUNT_B.userId),
    ])

    const groupApplication = await call(aSession, '/api/groups/apply', {
      method: 'POST',
      body: JSON.stringify({
        name: `[QA] ${RUN.slice(-18)}`,
        description: `[${RUN}] QA-only pending application; removed by this same run.`,
      }),
    })
    groupApplicationId = groupApplication.body?.application?.id || null
    assert(
      groupApplication.status < 300 && groupApplicationId,
      `group application submit failed (${groupApplication.status})`
    )
    const applications = await call(aSession, '/api/groups/apply', { method: 'GET' })
    const applicationRows = applications.body?.applications || []
    assert(
      applicationRows.some(
        (application) => application.id === groupApplicationId && application.status === 'pending'
      ),
      'group application GET read-back missed pending application'
    )
    note(`OK group application persisted: ${groupApplicationId}`)

    const created = await call(bSession, '/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: `[${RUN}] controlled notification post`,
        content: `[${RUN}] automated QA-only post; deleted by this same run.`,
        visibility: 'followers',
      }),
    })
    postId = created.body?.data?.post?.id || created.body?.data?.id || null
    assert(created.status === 201 && postId, `QA-B post create failed (${created.status})`)
    note(`OK post created: ${postId}`)

    const followed = await call(aSession, '/api/users/follow', {
      method: 'POST',
      body: JSON.stringify({ followingId: ACCOUNT_B.userId, action: 'follow' }),
    })
    assert(
      followed.status < 300 && followed.body?.following === true,
      `follow failed (${followed.status})`
    )
    followedByRun = true
    const followAfter = await call(
      aSession,
      `/api/users/follow?followingId=${encodeURIComponent(ACCOUNT_B.userId)}`,
      { method: 'GET' }
    )
    assert(followAfter.body?.following === true, 'follow GET read-back is false')
    note('OK QA-A → QA-B follow persisted')

    const commented = await call(aSession, `/api/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: `[${RUN}] QA-A comment; deleted by this same run.` }),
    })
    commentId = commented.body?.data?.comment?.id || commented.body?.data?.id || null
    assert(commented.status === 201 && commentId, `comment create failed (${commented.status})`)
    const comments = await call(aSession, `/api/posts/${postId}/comments`, { method: 'GET' })
    const commentRows = comments.body?.data?.comments || comments.body?.comments || []
    assert(
      commentRows.some((comment) => comment.id === commentId),
      'comment GET read-back missed created comment'
    )
    note(`OK comment persisted: ${commentId}`)

    // B3: every mutation is followed by an authenticated GET read-back, then
    // reverted before the post itself is removed. These are QA-A's own writes
    // on QA-B's hidden post, so there is no real-user notification surface.
    const bookmarked = await call(aSession, `/api/posts/${postId}/bookmark`, {
      method: 'POST',
      body: '{}',
    })
    assert(
      bookmarked.status < 300 && bookmarked.body?.bookmarked === true,
      `bookmark add failed (${bookmarked.status})`
    )
    const bookmarkOn = await call(aSession, `/api/posts/${postId}/bookmark`, { method: 'GET' })
    assert(bookmarkOn.body?.bookmarked === true, 'bookmark GET read-back is false after add')
    const unbookmarked = await call(aSession, `/api/posts/${postId}/bookmark`, {
      method: 'POST',
      body: '{}',
    })
    assert(
      unbookmarked.status < 300 && unbookmarked.body?.bookmarked === false,
      `bookmark removal failed (${unbookmarked.status})`
    )
    const bookmarkOff = await call(aSession, `/api/posts/${postId}/bookmark`, { method: 'GET' })
    assert(
      bookmarkOff.body?.bookmarked === false,
      'bookmark GET read-back remains true after removal'
    )
    note('OK bookmark persisted and was removed')

    const voted = await call(aSession, `/api/posts/${postId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ choice: 'bull' }),
    })
    assert(
      voted.status < 300 && voted.body?.data?.vote === 'bull',
      `vote add failed (${voted.status})`
    )
    const voteOn = await call(aSession, `/api/posts/${postId}`, { method: 'GET' })
    assert(voteOn.body?.data?.post?.user_vote === 'bull', 'post GET read-back missed bull vote')
    const unvoted = await call(aSession, `/api/posts/${postId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ choice: 'bull' }),
    })
    assert(
      unvoted.status < 300 && unvoted.body?.data?.vote === null,
      `vote removal failed (${unvoted.status})`
    )
    const voteOff = await call(aSession, `/api/posts/${postId}`, { method: 'GET' })
    assert(voteOff.body?.data?.post?.user_vote === null, 'post GET read-back retains removed vote')
    note('OK poll vote persisted and was removed')

    const liked = await call(aSession, `/api/posts/${postId}/comments/like`, {
      method: 'POST',
      body: JSON.stringify({ comment_id: commentId, type: 'like' }),
    })
    assert(
      liked.status < 300 && liked.body?.data?.liked === true,
      `comment like failed (${liked.status})`
    )
    const likeOnRows =
      (await call(aSession, `/api/posts/${postId}/comments`, { method: 'GET' })).body?.data
        ?.comments || []
    assert(
      flattenComments(likeOnRows).some(
        (comment) => comment.id === commentId && comment.user_liked === true
      ),
      'comment GET read-back missed like'
    )
    const unliked = await call(aSession, `/api/posts/${postId}/comments/like`, {
      method: 'POST',
      body: JSON.stringify({ comment_id: commentId, type: 'like' }),
    })
    assert(
      unliked.status < 300 && unliked.body?.data?.liked === false,
      `comment unlike failed (${unliked.status})`
    )
    const likeOffRows =
      (await call(aSession, `/api/posts/${postId}/comments`, { method: 'GET' })).body?.data
        ?.comments || []
    assert(
      flattenComments(likeOffRows).some(
        (comment) => comment.id === commentId && comment.user_liked === false
      ),
      'comment GET read-back retains removed like'
    )
    note('OK comment like persisted and was removed')

    // B replies to A's comment. This deliberately exercises post_reply
    // notification delivery to QA-A; both users and the post remain controlled.
    const replied = await call(bSession, `/api/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        content: `[${RUN}] QA-B reply; deleted by this same run.`,
        parent_id: commentId,
      }),
    })
    replyId = replied.body?.data?.comment?.id || replied.body?.data?.id || null
    assert(replied.status === 201 && replyId, `reply create failed (${replied.status})`)
    const replyRows =
      (await call(aSession, `/api/posts/${postId}/comments`, { method: 'GET' })).body?.data
        ?.comments || []
    assert(
      flattenComments(replyRows).some(
        (comment) => comment.id === replyId && comment.parent_id === commentId
      ),
      'comment GET read-back missed reply'
    )
    note(`OK reply persisted: ${replyId}`)

    // Notification writes are fire-and-forget. Poll the direct read path,
    // because the user-facing list's 30s cache is unsuitable for a 30s command
    // runner; the baseline above makes this strictly this-run-only.
    let bNewNotifications = []
    let aNewNotifications = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const [aRows, bRows] = await Promise.all([
        listNotifications(ACCOUNT_A.userId),
        listNotifications(ACCOUNT_B.userId),
      ])
      aNewNotifications = aRows.filter(
        (notification) =>
          !aNotificationsBefore.has(notification.id) && notification.actor_id === ACCOUNT_B.userId
      )
      bNewNotifications = bRows.filter(
        (notification) =>
          !bNotificationsBefore.has(notification.id) && notification.actor_id === ACCOUNT_A.userId
      )
      const bTypes = new Set(bNewNotifications.map((notification) => notification.type))
      const aTypes = new Set(aNewNotifications.map((notification) => notification.type))
      if (
        (bTypes.has('new_follower') || bTypes.has('follow')) &&
        bTypes.has('comment') &&
        (aTypes.has('post_reply') || aTypes.has('comment'))
      )
        break
      await page.waitForTimeout(750)
    }
    const bTypes = new Set(bNewNotifications.map((notification) => notification.type))
    const aTypes = new Set(aNewNotifications.map((notification) => notification.type))
    assert(
      (bTypes.has('new_follower') || bTypes.has('follow')) && bTypes.has('comment'),
      `QA-B missing this-run follow/comment notifications (got: ${[...bTypes].join(', ') || 'none'})`
    )
    assert(
      aTypes.has('post_reply') || aTypes.has('comment'),
      `QA-A missing this-run reply notification (got: ${[...aTypes].join(', ') || 'none'})`
    )
    notificationsToClean.push(
      ...bNewNotifications.map((notification) => ({ session: bSession, id: notification.id })),
      ...aNewNotifications.map((notification) => ({ session: aSession, id: notification.id }))
    )
    note(`OK QA-B inbox received this-run: ${[...bTypes].join(', ')}`)
    note(`OK QA-A inbox received this-run: ${[...aTypes].join(', ')}`)
    // Do not narrow by a single type/reference here: production has used both
    // follow/new_follower and comment/post_reply variants. The pre-run ID
    // baseline above is the authoritative run boundary.
  } finally {
    const clean = async (label, fn) => {
      try {
        await fn()
        note(`CLEAN ${label}`)
      } catch (error) {
        const message = `${label}: ${error instanceof Error ? error.message : String(error)}`
        cleanupFailures.push(message)
        console.error(`CLEANUP FAILED ${message}`)
      }
    }

    if (replyId && postId) {
      await clean('reply', async () => {
        const deleted = await call(bSession, `/api/posts/${postId}/comments`, {
          method: 'DELETE',
          body: JSON.stringify({ comment_id: replyId }),
        })
        assert(deleted.status < 300, `delete returned ${deleted.status}`)
      })
    }
    if (commentId && postId) {
      await clean('comment', async () => {
        const deleted = await call(aSession, `/api/posts/${postId}/comments`, {
          method: 'DELETE',
          body: JSON.stringify({ comment_id: commentId }),
        })
        assert(deleted.status < 300, `delete returned ${deleted.status}`)
      })
    }
    if (followedByRun) {
      await clean('follow', async () => {
        const unfollowed = await call(aSession, '/api/users/follow', {
          method: 'POST',
          body: JSON.stringify({ followingId: ACCOUNT_B.userId, action: 'unfollow' }),
        })
        assert(unfollowed.status < 300, `unfollow returned ${unfollowed.status}`)
        const after = await call(
          aSession,
          `/api/users/follow?followingId=${encodeURIComponent(ACCOUNT_B.userId)}`,
          { method: 'GET' }
        )
        assert(after.body?.following === false, 'follow GET read-back still true after cleanup')
      })
    }
    if (postId) {
      await clean('post', async () => {
        const deleted = await call(bSession, `/api/posts/${postId}`, { method: 'DELETE' })
        assert(deleted.status < 300, `delete returned ${deleted.status}`)
        const after = await call(bSession, `/api/posts/${postId}`, { method: 'GET' })
        assert(after.status === 404, `post GET after cleanup returned ${after.status}`)
      })
    }
    if (groupApplicationId) {
      await clean('pending group application', async () => {
        await deletePendingQaApplication(groupApplicationId)
        const applications = await call(aSession, '/api/groups/apply', { method: 'GET' })
        const rows = applications.body?.applications || []
        assert(
          !rows.some((application) => application.id === groupApplicationId),
          'pending application GET still returns cleaned row'
        )
      })
    }
    for (const notification of notificationsToClean) {
      if (!notification.id) continue
      await clean(`notification ${notification.id}`, async () => {
        const deleted = await call(notification.session, '/api/notifications', {
          method: 'DELETE',
          body: JSON.stringify({ notification_id: notification.id }),
        })
        assert(deleted.status < 300, `delete returned ${deleted.status}`)
      })
    }
    await browser.close()
  }

  if (cleanupFailures.length) throw new Error(`cleanup incomplete: ${cleanupFailures.join(' | ')}`)
  note(`PASS controlled QA write flow (${RUN})`)
}

main()
  .then(() => {
    persistResult('passed')
  })
  .catch((error) => {
    persistResult('failed', error instanceof Error ? error.message : String(error))
    console.error(
      `FAIL controlled QA write flow: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  })
  .finally(() => {
    if (results.length) process.stdout.write(`Summary: ${results.length} verified/cleanup steps\n`)
  })
