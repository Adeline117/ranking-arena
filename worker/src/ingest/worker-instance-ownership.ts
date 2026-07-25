import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

/**
 * Control-plane ownership protocol for one cooperative worker process.
 *
 * Redis replication/failover alone is not a durable write fence. Do not wire
 * this lease into production consumers until leaseEpoch is also activated and
 * rejected when stale at every authoritative database/publication boundary.
 * The v3 roster is observability evidence, not the fencing authority.
 */

export const WORKER_OWNERSHIP_CONTRACT = 'arena.worker-ownership@1' as const
export const WORKER_OWNERSHIP_HASH_TAG = '{worker}'
export const WORKER_OWNER_LEASE_PREFIX = `arena:${WORKER_OWNERSHIP_HASH_TAG}:owner:`
export const WORKER_OWNER_EPOCH_PREFIX = `arena:${WORKER_OWNERSHIP_HASH_TAG}:epoch:`
export const WORKER_OWNER_RECORDS_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:owners`
export const WORKER_INSTANCE_RECORDS_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:instances`
export const WORKER_INSTANCE_INDEX_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:instance-index`
export const WORKER_ROSTER_V3_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:roster:v3`

export const WORKER_OWNER_LEASE_TTL_MS = 180_000
export const WORKER_OWNER_LEASE_RENEW_MS = 30_000
export const WORKER_OWNER_SELF_FENCE_MS = 150_000
export const WORKER_INSTANCE_RECORD_RETENTION_MS = 24 * 60 * 60_000
export const WORKER_INSTANCE_RECORD_LIMIT = 512

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{64}$/
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OWNER_TOKEN = /^[0-9a-f]{64}$/
const NATIVE_REGIONS = new Set(['local', 'vps_sg'])

const ACQUIRE_OWNERSHIP = `
-- arena.worker-ownership.acquire@1
local function key_type(key)
  local result = redis.call("type", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function now_ms()
  local value = redis.call("time")
  return tonumber(value[1]) * 1000 + math.floor(tonumber(value[2]) / 1000)
end
local function copy_table(value)
  local result = {}
  for key, item in pairs(value) do result[key] = item end
  return result
end
local function record_instance(field, encoded, now, protectedA, protectedB)
  local protected = {[protectedA] = true}
  if protectedB then protected[protectedB] = true end
  local activeOwners = redis.call("hvals", KEYS[3])
  for _, rawOwner in ipairs(activeOwners) do
    local decoded, owner = pcall(cjson.decode, rawOwner)
    if decoded and type(owner) == "table" and type(owner.node) == "string" and
       type(owner.instance_id) == "string" and tonumber(owner.lease_epoch) then
      protected[owner.node .. "/" .. owner.instance_id .. "/" ..
        tostring(owner.lease_epoch)] = true
    end
  end
  redis.call("hset", KEYS[4], field, encoded)
  redis.call("zadd", KEYS[6], now, field)
  local cutoff = now - tonumber(ARGV[8])
  local stale = redis.call("zrangebyscore", KEYS[6], "-inf", cutoff, "LIMIT", 0, 128)
  for _, candidate in ipairs(stale) do
    if not protected[candidate] then
      redis.call("hdel", KEYS[4], candidate)
      redis.call("zrem", KEYS[6], candidate)
    end
  end
  local excess = redis.call("zcard", KEYS[6]) - tonumber(ARGV[9])
  if excess > 0 then
    local candidates = redis.call("zrange", KEYS[6], 0, excess + 2)
    local removed = 0
    for _, candidate in ipairs(candidates) do
      if removed < excess and not protected[candidate] then
        redis.call("hdel", KEYS[4], candidate)
        redis.call("zrem", KEYS[6], candidate)
        removed = removed + 1
      end
    end
  end
end

local now = now_ms()
if (key_type(KEYS[1]) ~= "none" and key_type(KEYS[1]) ~= "string") or
   (key_type(KEYS[2]) ~= "none" and key_type(KEYS[2]) ~= "string") or
   (key_type(KEYS[3]) ~= "none" and key_type(KEYS[3]) ~= "hash") or
   (key_type(KEYS[4]) ~= "none" and key_type(KEYS[4]) ~= "hash") or
   (key_type(KEYS[5]) ~= "none" and key_type(KEYS[5]) ~= "hash") or
   (key_type(KEYS[6]) ~= "none" and key_type(KEYS[6]) ~= "zset") then
  return {-1, 0, now}
end

local rawEpoch = redis.call("get", KEYS[2])
if rawEpoch and (not string.match(rawEpoch, "^%d+$") or
   (string.len(rawEpoch) > 1 and string.sub(rawEpoch, 1, 1) == "0")) then
  return {-1, 0, now}
end
local currentEpoch = tonumber(rawEpoch or "0")
if not currentEpoch or currentEpoch < 0 or currentEpoch > 9007199254740000 or
   currentEpoch ~= math.floor(currentEpoch) then
  return {-1, 0, now}
end
local base = cjson.decode(ARGV[6])
local contenderField = ARGV[2] .. "/" .. ARGV[3] .. "/" ..
  tostring(currentEpoch) .. "/contender"
local instance = copy_table(base)
instance.contract = ARGV[7]
instance.instance_id = ARGV[3]
instance.lease_epoch = currentEpoch
instance.node = ARGV[2]
instance.status = "contender"
instance.ts = now
local encodedContender = cjson.encode(instance)
local currentToken = redis.call("get", KEYS[1])
local rawOwner = redis.call("hget", KEYS[3], ARGV[2])
local rawRoster = redis.call("hget", KEYS[5], ARGV[2])
local ownerDecoded = false
local previousOwner = nil
if rawOwner then
  ownerDecoded, previousOwner = pcall(cjson.decode, rawOwner)
  if not ownerDecoded or type(previousOwner) ~= "table" then return {-1, 0, now} end
end
local rosterDecoded = false
local previousRoster = nil
if rawRoster then
  rosterDecoded, previousRoster = pcall(cjson.decode, rawRoster)
  if not rosterDecoded or type(previousRoster) ~= "table" then return {-1, 0, now} end
end

if currentToken then
  local ttl = redis.call("pttl", KEYS[1])
  local tokenValid = string.len(currentToken) == 64 and
    not string.find(currentToken, "[^0-9a-f]")
  local ownerValid = previousOwner and previousRoster and currentEpoch >= 1 and
    previousOwner.contract == ARGV[7] and previousOwner.node == ARGV[2] and
    type(previousOwner.instance_id) == "string" and
    tonumber(previousOwner.lease_epoch) == currentEpoch and
    previousRoster.contract == ARGV[7] and previousRoster.node == ARGV[2] and
    previousRoster.instance_id == previousOwner.instance_id and
    tonumber(previousRoster.lease_epoch) == currentEpoch
  if ttl <= 0 or not tokenValid or not ownerValid then return {-1, 0, now} end

  if currentToken == ARGV[1] then
    if previousOwner.instance_id ~= ARGV[3] then return {-1, 0, now} end
    instance.lease_epoch = currentEpoch
    instance.status = "owner"
    local replayOwner = copy_table(instance)
    replayOwner.lease_expires_at = now + tonumber(ARGV[4])
    replayOwner.status = nil
    local replayRoster = copy_table(replayOwner)
    replayRoster.lease_expires_at = nil
    local encodedReplayOwner = cjson.encode(replayOwner)
    local encodedReplayInstance = cjson.encode(instance)
    local encodedReplayRoster = cjson.encode(replayRoster)
    local replayField = ARGV[2] .. "/" .. ARGV[3] .. "/" .. tostring(currentEpoch)
    redis.call("pexpire", KEYS[1], ARGV[4])
    redis.call("hset", KEYS[3], ARGV[2], encodedReplayOwner)
    record_instance(replayField, encodedReplayInstance, now, replayField, nil)
    redis.call("hset", KEYS[5], ARGV[2], encodedReplayRoster)
    return {1, currentEpoch, now}
  end

  local activeOwnerField = ARGV[2] .. "/" .. previousOwner.instance_id .. "/" ..
    tostring(currentEpoch)
  record_instance(contenderField, encodedContender, now, contenderField, activeOwnerField)
  return {0, currentEpoch, now}
end

if not rawEpoch and (rawOwner or rawRoster) then return {-1, 0, now} end
if (rawOwner and not rawRoster) or (rawRoster and not rawOwner) then return {-1, 0, now} end

local encodedExpiredOwner = nil
local expiredOwnerField = nil
if previousOwner then
  if previousOwner.contract ~= ARGV[7] or previousOwner.node ~= ARGV[2] or
     type(previousOwner.instance_id) ~= "string" or
     tonumber(previousOwner.lease_epoch) ~= currentEpoch or
     previousRoster.contract ~= ARGV[7] or previousRoster.node ~= ARGV[2] or
     previousRoster.instance_id ~= previousOwner.instance_id or
     tonumber(previousRoster.lease_epoch) ~= currentEpoch then
    return {-1, 0, now}
  end
  previousOwner.lease_expires_at = nil
  previousOwner.status = "expired"
  previousOwner.ts = now
  expiredOwnerField = ARGV[2] .. "/" .. previousOwner.instance_id .. "/" ..
    tostring(currentEpoch)
  encodedExpiredOwner = cjson.encode(previousOwner)
end

local nextEpoch = currentEpoch + 1
instance.lease_epoch = nextEpoch
instance.status = "owner"
local owner = copy_table(instance)
owner.lease_expires_at = now + tonumber(ARGV[4])
owner.status = nil
local roster = copy_table(owner)
roster.lease_expires_at = nil
local encodedOwner = cjson.encode(owner)
local encodedInstance = cjson.encode(instance)
local encodedRoster = cjson.encode(roster)
local registryField = ARGV[2] .. "/" .. ARGV[3] .. "/" .. tostring(nextEpoch)

local incremented = redis.call("incr", KEYS[2])
if incremented ~= nextEpoch then return {-1, 0, now} end
redis.call("psetex", KEYS[1], ARGV[4], ARGV[1])
if encodedExpiredOwner then
  record_instance(expiredOwnerField, encodedExpiredOwner, now, registryField, expiredOwnerField)
end
redis.call("hset", KEYS[3], ARGV[2], encodedOwner)
record_instance(registryField, encodedInstance, now, registryField, nil)
redis.call("hset", KEYS[5], ARGV[2], encodedRoster)
return {1, nextEpoch, now}
`

const RENEW_AND_PUBLISH = `
-- arena.worker-ownership.renew@1
local function key_type(key)
  local result = redis.call("type", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function now_ms()
  local value = redis.call("time")
  return tonumber(value[1]) * 1000 + math.floor(tonumber(value[2]) / 1000)
end
local function copy_table(value)
  local result = {}
  for key, item in pairs(value) do result[key] = item end
  return result
end
local function record_instance(field, encoded, now)
  local protected = {[field] = true}
  local activeOwners = redis.call("hvals", KEYS[3])
  for _, rawOwner in ipairs(activeOwners) do
    local decoded, owner = pcall(cjson.decode, rawOwner)
    if decoded and type(owner) == "table" and type(owner.node) == "string" and
       type(owner.instance_id) == "string" and tonumber(owner.lease_epoch) then
      protected[owner.node .. "/" .. owner.instance_id .. "/" ..
        tostring(owner.lease_epoch)] = true
    end
  end
  redis.call("hset", KEYS[4], field, encoded)
  redis.call("zadd", KEYS[6], now, field)
  local cutoff = now - tonumber(ARGV[8])
  local stale = redis.call("zrangebyscore", KEYS[6], "-inf", cutoff, "LIMIT", 0, 128)
  for _, candidate in ipairs(stale) do
    if not protected[candidate] then
      redis.call("hdel", KEYS[4], candidate)
      redis.call("zrem", KEYS[6], candidate)
    end
  end
  local excess = redis.call("zcard", KEYS[6]) - tonumber(ARGV[9])
  if excess > 0 then
    local candidates = redis.call("zrange", KEYS[6], 0, excess + 1)
    local removed = 0
    for _, candidate in ipairs(candidates) do
      if removed < excess and not protected[candidate] then
        redis.call("hdel", KEYS[4], candidate)
        redis.call("zrem", KEYS[6], candidate)
        removed = removed + 1
      end
    end
  end
end
local function fenced(base, now)
  local instance = copy_table(base)
  instance.contract = ARGV[7]
  instance.instance_id = ARGV[3]
  instance.lease_epoch = tonumber(ARGV[5])
  instance.node = ARGV[2]
  instance.status = "fenced"
  instance.ts = now
  local field = ARGV[2] .. "/" .. ARGV[3] .. "/" .. ARGV[5]
  record_instance(field, cjson.encode(instance), now)
  return {0, tonumber(ARGV[5]), now}
end

local now = now_ms()
if (key_type(KEYS[1]) ~= "none" and key_type(KEYS[1]) ~= "string") or
   (key_type(KEYS[2]) ~= "none" and key_type(KEYS[2]) ~= "string") or
   (key_type(KEYS[3]) ~= "none" and key_type(KEYS[3]) ~= "hash") or
   (key_type(KEYS[4]) ~= "none" and key_type(KEYS[4]) ~= "hash") or
   (key_type(KEYS[5]) ~= "none" and key_type(KEYS[5]) ~= "hash") or
   (key_type(KEYS[6]) ~= "none" and key_type(KEYS[6]) ~= "zset") then
  return {-1, tonumber(ARGV[5]), now}
end
local base = cjson.decode(ARGV[6])
local token = redis.call("get", KEYS[1])
local rawEpoch = redis.call("get", KEYS[2])
if rawEpoch and (not string.match(rawEpoch, "^%d+$") or
   (string.len(rawEpoch) > 1 and string.sub(rawEpoch, 1, 1) == "0")) then
  return {-1, tonumber(ARGV[5]), now}
end
local epoch = tonumber(rawEpoch or "-1")
if not epoch or epoch < 0 or epoch > 9007199254740000 or
   epoch ~= math.floor(epoch) then
  return {-1, tonumber(ARGV[5]), now}
end
if token then
  local ttl = redis.call("pttl", KEYS[1])
  local tokenValid = string.len(token) == 64 and not string.find(token, "[^0-9a-f]")
  if ttl <= 0 or not tokenValid then return {-1, tonumber(ARGV[5]), now} end
end
local rawOwner = redis.call("hget", KEYS[3], ARGV[2])
local ownerValid = false
if rawOwner then
  local decoded, owner = pcall(cjson.decode, rawOwner)
  ownerValid = decoded and type(owner) == "table" and owner.contract == ARGV[7] and
    owner.node == ARGV[2] and owner.instance_id == ARGV[3] and
    tonumber(owner.lease_epoch) == tonumber(ARGV[5])
end
if token ~= ARGV[1] or epoch ~= tonumber(ARGV[5]) or not ownerValid then
  return fenced(base, now)
end

local instance = copy_table(base)
instance.contract = ARGV[7]
instance.instance_id = ARGV[3]
instance.lease_epoch = tonumber(ARGV[5])
instance.node = ARGV[2]
instance.status = "owner"
instance.ts = now
local owner = copy_table(instance)
owner.lease_expires_at = now + tonumber(ARGV[4])
owner.status = nil
local roster = copy_table(owner)
roster.lease_expires_at = nil
local encodedOwner = cjson.encode(owner)
local encodedInstance = cjson.encode(instance)
local encodedRoster = cjson.encode(roster)

redis.call("hset", KEYS[3], ARGV[2], encodedOwner)
record_instance(ARGV[2] .. "/" .. ARGV[3] .. "/" .. ARGV[5], encodedInstance, now)
redis.call("hset", KEYS[5], ARGV[2], encodedRoster)
redis.call("pexpire", KEYS[1], ARGV[4])
return {1, tonumber(ARGV[5]), now}
`

const RELEASE_OWNERSHIP = `
-- arena.worker-ownership.release@1
local function key_type(key)
  local result = redis.call("type", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function now_ms()
  local value = redis.call("time")
  return tonumber(value[1]) * 1000 + math.floor(tonumber(value[2]) / 1000)
end
local function copy_table(value)
  local result = {}
  for key, item in pairs(value) do result[key] = item end
  return result
end
local function record_instance(field, encoded, now)
  local protected = {[field] = true}
  local activeOwners = redis.call("hvals", KEYS[3])
  for _, rawOwner in ipairs(activeOwners) do
    local decoded, owner = pcall(cjson.decode, rawOwner)
    if decoded and type(owner) == "table" and type(owner.node) == "string" and
       type(owner.instance_id) == "string" and tonumber(owner.lease_epoch) then
      protected[owner.node .. "/" .. owner.instance_id .. "/" ..
        tostring(owner.lease_epoch)] = true
    end
  end
  redis.call("hset", KEYS[4], field, encoded)
  redis.call("zadd", KEYS[6], now, field)
  local cutoff = now - tonumber(ARGV[8])
  local stale = redis.call("zrangebyscore", KEYS[6], "-inf", cutoff, "LIMIT", 0, 128)
  for _, candidate in ipairs(stale) do
    if not protected[candidate] then
      redis.call("hdel", KEYS[4], candidate)
      redis.call("zrem", KEYS[6], candidate)
    end
  end
  local excess = redis.call("zcard", KEYS[6]) - tonumber(ARGV[9])
  if excess > 0 then
    local candidates = redis.call("zrange", KEYS[6], 0, excess + 1)
    local removed = 0
    for _, candidate in ipairs(candidates) do
      if removed < excess and not protected[candidate] then
        redis.call("hdel", KEYS[4], candidate)
        redis.call("zrem", KEYS[6], candidate)
        removed = removed + 1
      end
    end
  end
end
local function record_status(base, status, now)
  local instance = copy_table(base)
  instance.contract = ARGV[7]
  instance.instance_id = ARGV[3]
  instance.lease_epoch = tonumber(ARGV[5])
  instance.node = ARGV[2]
  instance.status = status
  instance.ts = now
  local field = ARGV[2] .. "/" .. ARGV[3] .. "/" .. ARGV[5]
  record_instance(field, cjson.encode(instance), now)
end

local now = now_ms()
if (key_type(KEYS[1]) ~= "none" and key_type(KEYS[1]) ~= "string") or
   (key_type(KEYS[2]) ~= "none" and key_type(KEYS[2]) ~= "string") or
   (key_type(KEYS[3]) ~= "none" and key_type(KEYS[3]) ~= "hash") or
   (key_type(KEYS[4]) ~= "none" and key_type(KEYS[4]) ~= "hash") or
   (key_type(KEYS[5]) ~= "none" and key_type(KEYS[5]) ~= "hash") or
   (key_type(KEYS[6]) ~= "none" and key_type(KEYS[6]) ~= "zset") then
  return {-1, tonumber(ARGV[5]), now}
end
local base = cjson.decode(ARGV[6])
local token = redis.call("get", KEYS[1])
local rawEpoch = redis.call("get", KEYS[2])
if rawEpoch and (not string.match(rawEpoch, "^%d+$") or
   (string.len(rawEpoch) > 1 and string.sub(rawEpoch, 1, 1) == "0")) then
  return {-1, tonumber(ARGV[5]), now}
end
local epoch = tonumber(rawEpoch or "-1")
if not epoch or epoch < 0 or epoch > 9007199254740000 or
   epoch ~= math.floor(epoch) then
  return {-1, tonumber(ARGV[5]), now}
end
if token then
  local ttl = redis.call("pttl", KEYS[1])
  local tokenValid = string.len(token) == 64 and not string.find(token, "[^0-9a-f]")
  if ttl <= 0 or not tokenValid then return {-1, tonumber(ARGV[5]), now} end
end
local rawOwner = redis.call("hget", KEYS[3], ARGV[2])
local ownerValid = false
if rawOwner then
  local decoded, owner = pcall(cjson.decode, rawOwner)
  ownerValid = decoded and type(owner) == "table" and owner.contract == ARGV[7] and
    owner.node == ARGV[2] and owner.instance_id == ARGV[3] and
    tonumber(owner.lease_epoch) == tonumber(ARGV[5])
end
if token ~= ARGV[1] or epoch ~= tonumber(ARGV[5]) or not ownerValid then
  record_status(base, "fenced", now)
  return {0, tonumber(ARGV[5]), now}
end

record_status(base, "released", now)
redis.call("hdel", KEYS[5], ARGV[2])
redis.call("hdel", KEYS[3], ARGV[2])
redis.call("del", KEYS[1])
return {1, tonumber(ARGV[5]), now}
`

export interface WorkerOwnershipRedis {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}

export interface WorkerOwnershipHeartbeatInput {
  attempt_bound_capture: boolean
  disk?: number
  node: string
  pid: number
  regions: string[]
  release_id: string
  sha: string
}

export interface WorkerOwnershipProof {
  readonly instanceId: string
  readonly leaseEpoch: number
  readonly node: string
  readonly serverTimeMs: number
}

export interface WorkerOwnershipLease {
  readonly proof: WorkerOwnershipProof
  readonly signal: AbortSignal
  isOwned(): boolean
  release(): Promise<boolean>
  renewAndPublish(heartbeat: WorkerOwnershipHeartbeatInput): Promise<boolean>
}

export type WorkerOwnershipAcquireResult =
  | {
      instanceId: string
      observedEpoch: number
      serverTimeMs: number
      status: 'contended'
    }
  | { lease: WorkerOwnershipLease; status: 'owned' }

interface WorkerOwnershipIdentity {
  instanceId: string
  ownerToken: string
}

interface AcquireWorkerOwnershipOptions {
  heartbeat: WorkerOwnershipHeartbeatInput
  identity?: WorkerOwnershipIdentity
  monotonicNow?: () => number
  redis: WorkerOwnershipRedis
}

function validateIdentity(identity: WorkerOwnershipIdentity): void {
  if (!INSTANCE_ID.test(identity.instanceId)) {
    throw new Error('[ingest-worker] worker instance identity is malformed')
  }
  if (!OWNER_TOKEN.test(identity.ownerToken)) {
    throw new Error('[ingest-worker] worker owner token is malformed')
  }
}

function createIdentity(): WorkerOwnershipIdentity {
  return { instanceId: randomUUID(), ownerToken: randomBytes(32).toString('hex') }
}

export function workerOwnershipKeys(node: string) {
  if (!NODE_ID.test(node)) throw new Error('[ingest-worker] unsafe worker node identity')
  return {
    epoch: `${WORKER_OWNER_EPOCH_PREFIX}${node}`,
    index: WORKER_INSTANCE_INDEX_KEY,
    instances: WORKER_INSTANCE_RECORDS_KEY,
    lease: `${WORKER_OWNER_LEASE_PREFIX}${node}`,
    owners: WORKER_OWNER_RECORDS_KEY,
    roster: WORKER_ROSTER_V3_KEY,
  } as const
}

function serializeHeartbeat(heartbeat: WorkerOwnershipHeartbeatInput): string {
  workerOwnershipKeys(heartbeat.node)
  const ownKeys = Object.keys(heartbeat)
  const allowedKeys = new Set([
    'attempt_bound_capture',
    'disk',
    'node',
    'pid',
    'regions',
    'release_id',
    'sha',
  ])
  if (
    ownKeys.some((key) => !allowedKeys.has(key)) ||
    Object.prototype.hasOwnProperty.call(heartbeat, 'toJSON') ||
    !Number.isSafeInteger(heartbeat.pid) ||
    heartbeat.pid <= 0 ||
    !Array.isArray(heartbeat.regions) ||
    heartbeat.regions.length !== 1 ||
    heartbeat.regions.some(
      (region) =>
        typeof region !== 'string' ||
        region.length === 0 ||
        region.length > 80 ||
        region.trim() !== region
    ) ||
    !NATIVE_REGIONS.has(heartbeat.regions[0] ?? '') ||
    !COMMIT_SHA.test(heartbeat.sha) ||
    !RELEASE_ID.test(heartbeat.release_id) ||
    typeof heartbeat.attempt_bound_capture !== 'boolean' ||
    (heartbeat.disk !== undefined &&
      (!Number.isInteger(heartbeat.disk) || heartbeat.disk < 0 || heartbeat.disk > 100))
  ) {
    throw new Error('[ingest-worker] worker ownership heartbeat is malformed')
  }
  const exact: WorkerOwnershipHeartbeatInput = {
    attempt_bound_capture: heartbeat.attempt_bound_capture,
    node: heartbeat.node,
    pid: heartbeat.pid,
    regions: [...heartbeat.regions],
    release_id: heartbeat.release_id,
    sha: heartbeat.sha,
  }
  if (heartbeat.disk !== undefined) exact.disk = heartbeat.disk
  const encoded = JSON.stringify(exact)
  if (encoded.length > 4_096) {
    throw new Error('[ingest-worker] worker ownership heartbeat is oversized')
  }
  return encoded
}

function parseScriptResult(value: unknown): {
  epoch: number
  owned: boolean
  serverTimeMs: number
} {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('[ingest-worker] worker ownership script returned a malformed result')
  }
  const parseInteger = (raw: unknown): number | null => {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return null
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  const status = parseInteger(value[0])
  const epoch = parseInteger(value[1])
  const serverTimeMs = parseInteger(value[2])
  if (
    (status !== 0 && status !== 1) ||
    epoch === null ||
    epoch < 0 ||
    serverTimeMs === null ||
    serverTimeMs <= 0
  ) {
    throw new Error('[ingest-worker] worker ownership script returned an invalid result')
  }
  return { epoch, owned: status === 1, serverTimeMs }
}

function scriptArgs(
  keys: ReturnType<typeof workerOwnershipKeys>,
  identity: WorkerOwnershipIdentity,
  heartbeat: WorkerOwnershipHeartbeatInput,
  epoch?: number
): string[] {
  return [
    keys.lease,
    keys.epoch,
    keys.owners,
    keys.instances,
    keys.roster,
    keys.index,
    identity.ownerToken,
    heartbeat.node,
    identity.instanceId,
    String(WORKER_OWNER_LEASE_TTL_MS),
    epoch === undefined ? '' : String(epoch),
    serializeHeartbeat(heartbeat),
    WORKER_OWNERSHIP_CONTRACT,
    String(WORKER_INSTANCE_RECORD_RETENTION_MS),
    String(WORKER_INSTANCE_RECORD_LIMIT),
  ]
}

/**
 * Register this boot and atomically claim one logical node. The private owner
 * token is confined to the trusted Redis command/lease boundary and never
 * enters published owner, roster, instance records, or the returned proof.
 */
export async function acquireWorkerOwnership({
  heartbeat,
  identity = createIdentity(),
  monotonicNow = () => performance.now(),
  redis,
}: AcquireWorkerOwnershipOptions): Promise<WorkerOwnershipAcquireResult> {
  const ownerIdentity = { ...identity }
  validateIdentity(ownerIdentity)
  const initialHeartbeat = JSON.parse(
    serializeHeartbeat(heartbeat)
  ) as WorkerOwnershipHeartbeatInput
  const ownedNode = initialHeartbeat.node
  const keys = workerOwnershipKeys(ownedNode)
  const encoded = serializeHeartbeat(initialHeartbeat)
  const acquireStartedAt = monotonicNow()
  const acquired = parseScriptResult(
    await redis.eval(
      ACQUIRE_OWNERSHIP,
      6,
      keys.lease,
      keys.epoch,
      keys.owners,
      keys.instances,
      keys.roster,
      keys.index,
      ownerIdentity.ownerToken,
      ownedNode,
      ownerIdentity.instanceId,
      String(WORKER_OWNER_LEASE_TTL_MS),
      '',
      encoded,
      WORKER_OWNERSHIP_CONTRACT,
      String(WORKER_INSTANCE_RECORD_RETENTION_MS),
      String(WORKER_INSTANCE_RECORD_LIMIT)
    )
  )
  if (!acquired.owned) {
    return {
      instanceId: ownerIdentity.instanceId,
      observedEpoch: acquired.epoch,
      serverTimeMs: acquired.serverTimeMs,
      status: 'contended',
    }
  }
  if (acquired.epoch < 1) {
    throw new Error('[ingest-worker] worker ownership returned an invalid owned epoch')
  }
  if (monotonicNow() - acquireStartedAt >= WORKER_OWNER_SELF_FENCE_MS) {
    throw new Error('[ingest-worker] worker ownership proof arrived outside its safe lease window')
  }

  type LeaseState = 'owned' | 'releasing' | 'released' | 'fenced'
  let state: LeaseState = 'owned'
  let latestHeartbeat = initialHeartbeat
  let lastProofStartedAt = acquireStartedAt
  let watchdog: NodeJS.Timeout | undefined
  let operationTail: Promise<void> = Promise.resolve()
  let releasePromise: Promise<boolean> | undefined
  const abortController = new AbortController()
  let proof: WorkerOwnershipProof = {
    instanceId: ownerIdentity.instanceId,
    leaseEpoch: acquired.epoch,
    node: ownedNode,
    serverTimeMs: acquired.serverTimeMs,
  }

  const clearWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }
  const abort = (reason: Error) => {
    if (!abortController.signal.aborted) abortController.abort(reason)
  }
  const fence = (reason: Error) => {
    if (state === 'released' || state === 'fenced') return
    state = 'fenced'
    clearWatchdog()
    abort(reason)
  }
  const scheduleWatchdog = (proofStartedAt: number) => {
    lastProofStartedAt = proofStartedAt
    clearWatchdog()
    const remaining = WORKER_OWNER_SELF_FENCE_MS - (monotonicNow() - proofStartedAt)
    if (remaining <= 0) {
      fence(new Error('[ingest-worker] worker ownership proof expired before Redis lease TTL'))
      return
    }
    watchdog = setTimeout(
      () => fence(new Error('[ingest-worker] worker ownership renewal deadline expired')),
      remaining
    )
    watchdog.unref?.()
  }
  const isOwned = () => {
    if (state !== 'owned') return false
    if (monotonicNow() - lastProofStartedAt >= WORKER_OWNER_SELF_FENCE_MS) {
      fence(new Error('[ingest-worker] worker ownership proof expired before Redis lease TTL'))
      return false
    }
    return true
  }
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation)
    operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  scheduleWatchdog(acquireStartedAt)

  const lease: WorkerOwnershipLease = {
    get proof() {
      return { ...proof }
    },
    get signal() {
      return abortController.signal
    },
    isOwned,
    renewAndPublish: (nextHeartbeat) => {
      if (!isOwned()) return Promise.resolve(false)
      return enqueue(async () => {
        if (!isOwned()) return false
        const renewStartedAt = monotonicNow()
        try {
          const normalizedHeartbeat = JSON.parse(
            serializeHeartbeat(nextHeartbeat)
          ) as WorkerOwnershipHeartbeatInput
          if (normalizedHeartbeat.node !== ownedNode) {
            throw new Error('[ingest-worker] worker ownership node cannot change')
          }
          const result = parseScriptResult(
            await redis.eval(
              RENEW_AND_PUBLISH,
              6,
              ...scriptArgs(keys, ownerIdentity, normalizedHeartbeat, proof.leaseEpoch)
            )
          )
          if (result.epoch !== proof.leaseEpoch) {
            throw new Error('[ingest-worker] worker ownership renewal epoch changed')
          }
          if (state !== 'owned') return false
          if (!result.owned) {
            fence(new Error('[ingest-worker] worker ownership renewal was rejected'))
            return false
          }
          if (monotonicNow() - renewStartedAt >= WORKER_OWNER_SELF_FENCE_MS) {
            fence(new Error('[ingest-worker] worker ownership renewal arrived too late'))
            return false
          }
          latestHeartbeat = normalizedHeartbeat
          proof = { ...proof, serverTimeMs: result.serverTimeMs }
          scheduleWatchdog(renewStartedAt)
          return true
        } catch (error) {
          fence(error instanceof Error ? error : new Error(String(error)))
          throw error
        }
      })
    },
    release: () => {
      if (releasePromise) return releasePromise
      if (!isOwned()) return Promise.resolve(false)
      state = 'releasing'
      clearWatchdog()
      abort(new Error('[ingest-worker] worker ownership release started'))
      releasePromise = enqueue(async () => {
        try {
          const result = parseScriptResult(
            await redis.eval(
              RELEASE_OWNERSHIP,
              6,
              ...scriptArgs(keys, ownerIdentity, latestHeartbeat, proof.leaseEpoch)
            )
          )
          if (result.epoch !== proof.leaseEpoch) {
            throw new Error('[ingest-worker] worker ownership release epoch changed')
          }
          state = result.owned ? 'released' : 'fenced'
          return result.owned
        } catch (error) {
          state = 'fenced'
          throw error
        }
      })
      return releasePromise
    },
  }
  return { lease, status: 'owned' }
}
