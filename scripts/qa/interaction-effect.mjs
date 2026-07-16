export function hasObservableEffect(before, after, requestDelta) {
  if (!before || !after) return true
  if (requestDelta > 0) return true
  if (before.url !== after.url) return true
  if (before.textHash !== after.textHash) return true
  if (before.stateHash !== after.stateHash) return true
  if (Math.abs(before.textLen - after.textLen) > 2) return true
  if (before.overlays !== after.overlays) return true
  if (Math.abs(before.nodes - after.nodes) > 2) return true
  return false
}

export function clickEffectStatus({ before, after, requestDelta, activeChoice }) {
  if (hasObservableEffect(before, after, requestDelta)) return 'ok:clicked'
  // Re-selecting the active member of a segmented choice/tab group is a valid
  // idempotent interaction. Standalone pressed toggles are not covered by this
  // exemption because they are expected to switch off.
  if (activeChoice) return 'ok:active-choice'
  return 'dead:no-effect'
}
