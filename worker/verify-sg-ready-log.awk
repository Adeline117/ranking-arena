function canonicalPayload(line, prefix, payload) {
  if (substr(line, 1, 1) == "[") return line
  prefix = substr(line, 1, 21)
  if (prefix !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]: $/) return ""
  payload = substr(line, 22)
  if (substr(payload, 1, 1) != "[") return ""
  return payload
}

function isMetricTrustReady(line) {
  return canonicalPayload(line) == "[ingest-worker] metric-trust database release contract ready"
}

function isCommittedHeartbeat(line) {
  return index(canonicalPayload(line), "[heartbeat] redis-hset-committed ") == 1
}

function exactCommittedHeartbeat(line, expectedNode, expectedPid, expectedSha, expectedRelease, payload, count, fields) {
  payload = canonicalPayload(line)
  count = split(payload, fields, / /)
  if (count != 7) return 0
  if (fields[1] != "[heartbeat]" || fields[2] != "redis-hset-committed") return 0
  if (fields[3] != "node=" expectedNode || fields[4] != "pid=" expectedPid) return 0
  if (fields[5] != "sha=" expectedSha || fields[6] != "release=" expectedRelease) return 0
  return fields[7] ~ /^ts=[1-9][0-9]*$/
}

function isAuthorityReady(line) {
  return index(canonicalPayload(line), "[ingest-worker] native regional authority ready") == 1
}

function exactAuthorityReady(line, expectedRegion) {
  return canonicalPayload(line) == "[ingest-worker] native regional authority ready region=" expectedRegion
}

function isWorkerReady(line) {
  return index(canonicalPayload(line), "[ingest-worker] ready") == 1
}

function exactWorkerReady(line, expectedRegion, payload) {
  payload = canonicalPayload(line)
  return payload ~ ("^\\[ingest-worker\\] ready \\(regions=" expectedRegion ", concurrency=[1-9][0-9]*, fast-lane=(off|on×[1-9][0-9]*)\\)$")
}

$0 == marker {
  after = 1
  stage = 0
  invalid = 0
  next
}

after && stage < 4 && isMetricTrustReady($0) {
  if (stage == 0) stage = 1
  else invalid = 1
  next
}

after && stage < 4 && isCommittedHeartbeat($0) {
  expectedHeartbeat = exactCommittedHeartbeat($0, node, pid, sha, release)
  if (expectedHeartbeat) {
    if (stage == 1) stage = 2
    else invalid = 1
  }
  next
}

after && stage < 4 && isAuthorityReady($0) {
  if (stage == 2 && exactAuthorityReady($0, region)) stage = 3
  else invalid = 1
  next
}

after && stage < 4 && isWorkerReady($0) {
  if (stage == 3 && exactWorkerReady($0, region)) stage = 4
  else invalid = 1
  next
}

END {
  exit !(after && !invalid && stage == 4)
}
