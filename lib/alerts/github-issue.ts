/**
 * Independent alert channel — GitHub Issue (shared by the web alerting in
 * lib/alerts/send-alert.ts and the worker alerting in lib/ingest/alerting.ts).
 *
 * WHY: Telegram is the only real primary channel and has failed silently
 * before (2026-07-07: 401 token, nobody knew for hours). A same-title open
 * issue is commented on instead of duplicated.
 *
 * Env-gated: returns false unless BOTH a token and a repo are configured.
 *   - token: ALERT_GITHUB_TOKEN | GITHUB_TOKEN | GH_TOKEN
 *   - repo:  ALERT_GITHUB_REPO | GITHUB_REPOSITORY  (format: "owner/repo")
 * Never throws. Dependency-free so the worker processes can load it.
 */

export async function postGithubIssueAlert(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const token = env.ALERT_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN
  const repo = env.ALERT_GITHUB_REPO || env.GITHUB_REPOSITORY
  if (!token || !repo) return false

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'arena-alert-sentinel',
  }

  try {
    let existingNumber: number | null = null
    try {
      const q = `repo:${repo} is:issue is:open in:title "${title}"`
      const searchRes = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(q)}`,
        { headers, signal: AbortSignal.timeout(5000) }
      )
      if (searchRes.ok) {
        const sj = (await searchRes.json()) as { items?: Array<{ number: number; title: string }> }
        existingNumber = sj.items?.find((i) => i.title === title)?.number ?? null
      }
    } catch {
      // search failed — fall through to create a fresh issue
    }

    if (existingNumber) {
      const commentRes = await fetch(
        `https://api.github.com/repos/${repo}/issues/${existingNumber}/comments`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ body }),
          signal: AbortSignal.timeout(5000),
        }
      )
      return commentRes.ok
    }

    // No labels — a non-existent label makes the create call 422 and drops the alert.
    const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(5000),
    })
    return createRes.ok
  } catch (err) {
    console.error(
      '[github-issue-alert] GitHub issue channel failed:',
      err instanceof Error ? err.message : String(err)
    )
    return false
  }
}
