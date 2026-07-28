function exactToken(line, prefix, value, count, fields, i) {
  count = split(line, fields, /[[:space:]]+/)
  for (i = 1; i <= count; i += 1) {
    if (fields[i] == prefix value) return 1
  }
  return 0
}

function positiveIntegerToken(line, prefix, count, fields, i, value) {
  count = split(line, fields, /[[:space:]]+/)
  for (i = 1; i <= count; i += 1) {
    if (index(fields[i], prefix) == 1) {
      value = substr(fields[i], length(prefix) + 1)
      if (value ~ /^[1-9][0-9]*$/) return 1
    }
  }
  return 0
}

index($0, marker) {
  after = 1
  ready = 0
  committed = 0
  next
}

after && index($0, "[ingest-worker] ready") {
  ready = 1
}

after && index($0, "[heartbeat] redis-hset-committed") &&
  exactToken($0, "node=", node) &&
  exactToken($0, "sha=", sha) &&
  exactToken($0, "release=", release) &&
  positiveIntegerToken($0, "pid=") &&
  positiveIntegerToken($0, "ts=") {
  committed = 1
}

END {
  exit !(after && ready && committed)
}
