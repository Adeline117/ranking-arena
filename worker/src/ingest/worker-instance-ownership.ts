import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

/**
 * Redis control-plane ownership for one region authority scope.
 *
 * This module is intentionally not wired into consumers yet. Redis proves
 * cooperative ownership, but authoritative writes are safe only after the same
 * private credential is activated and checked at every PostgreSQL write
 * boundary. The v4 roster is evidence, never the durable database fence.
 */

export const WORKER_OWNERSHIP_CONTRACT = 'arena.worker-ownership@2' as const
export const WORKER_OWNERSHIP_HASH_TAG = '{worker}'
export const WORKER_OWNER_LEASE_PREFIX = `arena:${WORKER_OWNERSHIP_HASH_TAG}:owner:v4:`
export const WORKER_OWNER_EPOCH_PREFIX = `arena:${WORKER_OWNERSHIP_HASH_TAG}:epoch:v4:`
export const WORKER_OWNER_RECORDS_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:owners:v4`
export const WORKER_INSTANCE_RECORDS_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:instances:v4`
export const WORKER_INSTANCE_INDEX_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:instance-index:v4`
export const WORKER_ROSTER_V4_KEY = `arena:${WORKER_OWNERSHIP_HASH_TAG}:roster:v4`

export const WORKER_OWNER_LEASE_TTL_MS = 180_000
export const WORKER_OWNER_LEASE_RENEW_MS = 30_000
export const WORKER_OWNER_SELF_FENCE_MS = 150_000
export const WORKER_OWNER_SAFETY_MARGIN_MS = WORKER_OWNER_LEASE_TTL_MS - WORKER_OWNER_SELF_FENCE_MS
export const WORKER_INSTANCE_RECORD_RETENTION_MS = 24 * 60 * 60_000
export const WORKER_INSTANCE_RECORD_LIMIT = 512

const MAX_CONTROL_EPOCH = 9_007_199_254_740_000
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{64}$/
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OWNER_TOKEN = /^[0-9a-f]{64}$/
const ZERO_COMMIT_SHA = '0'.repeat(40)
const ZERO_64 = '0'.repeat(64)

export type WorkerOwnershipRegion = 'local' | 'vps_sg'
export type WorkerAuthorityScope = `region:${WorkerOwnershipRegion}`

export function workerAuthorityScope(region: WorkerOwnershipRegion): WorkerAuthorityScope {
  if (region !== 'local' && region !== 'vps_sg') {
    throw new Error('[ingest-worker] unsupported worker ownership region')
  }
  return `region:${region}`
}

const LUA_COMMON = `
local MAX_SAFE = 9007199254740000
local CONTRACT = "arena.worker-ownership@2"
local LEASE_TTL = 180000
local SELF_FENCE = 150000
local SAFETY_MARGIN = LEASE_TTL - SELF_FENCE
local RECORD_RETENTION = 86400000
local RECORD_LIMIT = 512
local KEY_ROOT = "arena:{worker}:"

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
local function safe_integer(value, minimum)
  return type(value) == "number" and value >= minimum and value <= MAX_SAFE and
    value == math.floor(value)
end
local function valid_hex(value, length)
  return type(value) == "string" and string.len(value) == length and
    not string.find(value, "[^0-9a-f]") and
    value ~= string.rep("0", length)
end
local function valid_node(value)
  return type(value) == "string" and string.len(value) >= 1 and
    string.len(value) <= 128 and
    string.match(value, "^[A-Za-z0-9][A-Za-z0-9._%-]*$") ~= nil
end
local function valid_region(value)
  return value == "local" or value == "vps_sg"
end
local function valid_scope(scope, region)
  return valid_region(region) and scope == "region:" .. region
end
local function valid_uuid(value)
  if type(value) ~= "string" or string.len(value) ~= 36 or value ~= string.lower(value) then
    return false
  end
  if string.sub(value, 9, 9) ~= "-" or string.sub(value, 14, 14) ~= "-" or
     string.sub(value, 19, 19) ~= "-" or string.sub(value, 24, 24) ~= "-" then
    return false
  end
  local compact = string.gsub(value, "%-", "")
  return string.len(compact) == 32 and not string.find(string.lower(compact), "[^0-9a-f]") and
    string.find("12345", string.lower(string.sub(value, 15, 15)), 1, true) ~= nil and
    string.find("89ab", string.lower(string.sub(value, 20, 20)), 1, true) ~= nil
end
local function decode_table(raw)
  if type(raw) ~= "string" then return nil end
  local decoded, value = pcall(cjson.decode, raw)
  if not decoded or type(value) ~= "table" then return nil end
  return value
end
local function encode_table(value)
  local encoded, result = pcall(cjson.encode, value)
  if not encoded or type(result) ~= "string" then return nil end
  return result
end
local function valid_base(base, node, region)
  if type(base) ~= "table" then return false end
  local allowed = {
    attempt_bound_capture = true,
    disk = true,
    node = true,
    pid = true,
    regions = true,
    release_id = true,
    sha = true
  }
  for key, _ in pairs(base) do
    if not allowed[key] then return false end
  end
  return base.node == node and valid_node(base.node) and
    safe_integer(base.pid, 1) and type(base.regions) == "table" and
    #base.regions == 1 and base.regions[1] == region and
    valid_hex(base.release_id, 64) and valid_hex(base.sha, 40) and
    type(base.attempt_bound_capture) == "boolean" and
    (base.disk == nil or (safe_integer(base.disk, 0) and base.disk <= 100))
end
local function valid_record(record)
  if type(record) ~= "table" then return false end
  local allowed = {
    attempt_bound_capture = true,
    authority_scope = true,
    contract = true,
    control_epoch = true,
    control_server_time_ms = true,
    disk = true,
    initial_control_server_time_ms = true,
    instance_id = true,
    lease_expires_at = true,
    node = true,
    pid = true,
    regions = true,
    release_id = true,
    sha = true,
    ts = true,
    worker_region = true
  }
  for key, _ in pairs(record) do
    if not allowed[key] then return false end
  end
  return record.contract == CONTRACT and
    valid_scope(record.authority_scope, record.worker_region) and
    valid_node(record.node) and valid_uuid(record.instance_id) and
    safe_integer(record.control_epoch, 1) and
    safe_integer(record.initial_control_server_time_ms, 1) and
    safe_integer(record.control_server_time_ms, 1) and
    record.initial_control_server_time_ms <= record.control_server_time_ms and
    safe_integer(record.ts, 1) and record.ts == record.control_server_time_ms and
    safe_integer(record.pid, 1) and type(record.regions) == "table" and
    #record.regions == 1 and record.regions[1] == record.worker_region and
    valid_hex(record.release_id, 64) and valid_hex(record.sha, 40) and
    type(record.attempt_bound_capture) == "boolean" and
    (record.disk == nil or (safe_integer(record.disk, 0) and record.disk <= 100)) and
    (record.lease_expires_at == nil or safe_integer(record.lease_expires_at, 1))
end
local function immutable_matches(record, base, node, scope, region, instanceId)
  return record.node == node and record.authority_scope == scope and
    record.worker_region == region and record.instance_id == instanceId and
    record.pid == base.pid and record.release_id == base.release_id and
    record.sha == base.sha
end
local function records_match(owner, roster)
  return owner.contract == roster.contract and
    owner.authority_scope == roster.authority_scope and
    owner.worker_region == roster.worker_region and owner.node == roster.node and
    owner.instance_id == roster.instance_id and
    owner.control_epoch == roster.control_epoch and
    owner.initial_control_server_time_ms == roster.initial_control_server_time_ms and
    owner.control_server_time_ms == roster.control_server_time_ms and
    owner.pid == roster.pid and owner.release_id == roster.release_id and
    owner.sha == roster.sha and
    owner.attempt_bound_capture == roster.attempt_bound_capture and
    owner.disk == roster.disk and safe_integer(owner.ts, 1) and
    owner.ts == owner.control_server_time_ms and roster.ts == owner.ts and
    owner.status == nil and roster.status == nil and
    owner.lease_expires_at ~= nil and
    owner.lease_expires_at > owner.control_server_time_ms and
    roster.lease_expires_at == nil
end
local function history_field(scope, node, instanceId, epoch)
  return scope .. "/" .. node .. "/" .. instanceId .. "/" .. tostring(epoch)
end
local function parse_counter(raw)
  if raw == false or raw == nil then return 0 end
  if type(raw) ~= "string" or not string.match(raw, "^%d+$") or
     (string.len(raw) > 1 and string.sub(raw, 1, 1) == "0") then
    return nil
  end
  local value = tonumber(raw)
  if not safe_integer(value, 0) then return nil end
  return value
end
local function valid_environment()
  if (key_type(KEYS[1]) ~= "none" and key_type(KEYS[1]) ~= "string") or
     (key_type(KEYS[2]) ~= "none" and key_type(KEYS[2]) ~= "string") or
     (key_type(KEYS[3]) ~= "none" and key_type(KEYS[3]) ~= "hash") or
     (key_type(KEYS[4]) ~= "none" and key_type(KEYS[4]) ~= "hash") or
     (key_type(KEYS[5]) ~= "none" and key_type(KEYS[5]) ~= "hash") or
     (key_type(KEYS[6]) ~= "none" and key_type(KEYS[6]) ~= "zset") then
    return false
  end
  return KEYS[1] == KEY_ROOT .. "owner:v4:" .. ARGV[3] and
    KEYS[2] == KEY_ROOT .. "epoch:v4:" .. ARGV[2] and
    KEYS[3] == KEY_ROOT .. "owners:v4" and
    KEYS[4] == KEY_ROOT .. "instances:v4" and
    KEYS[5] == KEY_ROOT .. "roster:v4" and
    KEYS[6] == KEY_ROOT .. "instance-index:v4" and
    ARGV[9] == CONTRACT and valid_hex(ARGV[1], 64) and
    valid_node(ARGV[2]) and valid_scope(ARGV[3], ARGV[4]) and
    valid_uuid(ARGV[5]) and ARGV[6] == tostring(LEASE_TTL) and
    ARGV[10] == tostring(RECORD_RETENTION) and
    ARGV[11] == tostring(RECORD_LIMIT)
end
local function load_pair(scope)
  local rawOwner = redis.call("hget", KEYS[3], scope)
  local rawRoster = redis.call("hget", KEYS[5], scope)
  if not rawOwner and not rawRoster then return true, nil, nil end
  if not rawOwner or not rawRoster then return false, nil, nil end
  local owner = decode_table(rawOwner)
  local roster = decode_table(rawRoster)
  if not valid_record(owner) or not valid_record(roster) or
     owner.authority_scope ~= scope or not records_match(owner, roster) then
    return false, nil, nil
  end
  return true, owner, roster
end
local function collect_protected(node)
  local protected = {}
  local activeNodeHighWater = 0
  local generationScopes = {}
  local instanceScopes = {}
  local function observe(scope, record)
    if not valid_record(record) or record.authority_scope ~= scope then return true end
    local generation = record.node .. "/" .. tostring(record.control_epoch)
    local canonicalInstance = string.lower(record.instance_id)
    if (generationScopes[generation] and generationScopes[generation] ~= scope) or
       (instanceScopes[canonicalInstance] and instanceScopes[canonicalInstance] ~= scope) then
      return false
    end
    generationScopes[generation] = scope
    instanceScopes[canonicalInstance] = scope
    protected[history_field(scope, record.node, record.instance_id, record.control_epoch)] = true
    if record.node == node and record.control_epoch > activeNodeHighWater then
      activeNodeHighWater = record.control_epoch
    end
    return true
  end
  local owners = redis.call("hgetall", KEYS[3])
  for index = 1, #owners, 2 do
    if not observe(owners[index], decode_table(owners[index + 1])) then return nil end
  end
  local rosters = redis.call("hgetall", KEYS[5])
  for index = 1, #rosters, 2 do
    if not observe(rosters[index], decode_table(rosters[index + 1])) then return nil end
  end
  return protected, activeNodeHighWater, instanceScopes
end
local function write_instance(protected, field, encoded, now, retention, limit)
  protected[field] = true
  redis.call("hset", KEYS[4], field, encoded)
  redis.call("zadd", KEYS[6], now, field)
  local cutoff = now - retention
  local stale = redis.call("zrangebyscore", KEYS[6], "-inf", cutoff, "LIMIT", 0, 128)
  for _, candidate in ipairs(stale) do
    if not protected[candidate] then
      redis.call("hdel", KEYS[4], candidate)
      redis.call("zrem", KEYS[6], candidate)
    end
  end
  local excess = redis.call("zcard", KEYS[6]) - limit
  if excess > 0 then
    local candidates = redis.call("zrange", KEYS[6], 0, math.min(excess + 16, 127))
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
local function make_instance(base, scope, region, instanceId, epoch, now, status)
  local instance = copy_table(base)
  instance.contract = CONTRACT
  instance.authority_scope = scope
  instance.worker_region = region
  instance.instance_id = instanceId
  instance.control_epoch = epoch
  instance.initial_control_server_time_ms = now
  instance.control_server_time_ms = now
  instance.status = status
  instance.ts = now
  instance.lease_expires_at = nil
  return instance
end
local function make_owner(instance, now, ttl)
  local owner = copy_table(instance)
  owner.status = nil
  owner.lease_expires_at = now + ttl
  local roster = copy_table(owner)
  roster.lease_expires_at = nil
  return owner, roster
end
local function refresh_owner(previous, base, now, ttl)
  local owner = copy_table(previous)
  owner.disk = base.disk
  owner.attempt_bound_capture = base.attempt_bound_capture
  owner.control_server_time_ms = now
  owner.ts = now
  owner.lease_expires_at = now + ttl
  local roster = copy_table(owner)
  roster.lease_expires_at = nil
  local instance = copy_table(roster)
  instance.status = "owner"
  return owner, roster, instance
end
`

const ACQUIRE_OWNERSHIP = `${LUA_COMMON}
-- arena.worker-ownership.acquire@2
local now = now_ms()
if not safe_integer(now, 1) or now + LEASE_TTL > MAX_SAFE then
  return {-1, 0, 0, 0, 0}
end
if not valid_environment() or ARGV[7] ~= "" then return {-1, 0, 0, 0, 0} end
local base = decode_table(ARGV[8])
if not valid_base(base, ARGV[2], ARGV[4]) then return {-1, 0, 0, 0, 0} end
local ttl = tonumber(ARGV[6])
local retention = tonumber(ARGV[10])
local limit = tonumber(ARGV[11])
local highWater = parse_counter(redis.call("get", KEYS[2]))
if highWater == nil then return {-1, 0, 0, 0, 0} end
local protected, activeNodeHighWater, seenInstances = collect_protected(ARGV[2])
if not protected then return {-1, 0, 0, 0, 0} end
if highWater < activeNodeHighWater then return {-1, 0, 0, 0, 0} end
local pairValid, previousOwner, previousRoster = load_pair(ARGV[3])
local currentToken = redis.call("get", KEYS[1])
if not pairValid then
  if currentToken then return {-1, 0, 0, 0, 0} end
  previousOwner = nil
  previousRoster = nil
end

if currentToken then
  local leaseTtl = redis.call("pttl", KEYS[1])
  if leaseTtl <= 0 or leaseTtl > ttl or not valid_hex(currentToken, 64) or
     not previousOwner or previousOwner.lease_expires_at <= now or
     now < previousOwner.control_server_time_ms then
    return {-1, 0, 0, 0, 0}
  end
  local ownerEpoch = previousOwner.control_epoch
  if currentToken == ARGV[1] then
    if not immutable_matches(previousOwner, base, ARGV[2], ARGV[3], ARGV[4], ARGV[5]) or
       leaseTtl <= SAFETY_MARGIN then
      return {-1, 0, 0, 0, 0}
    end
    -- Exact acquire replay recovers the original database activation proof.
    -- It is read-only and only succeeds while the original lease still leaves
    -- a positive local window plus the full safety margin; it never renews.
    return {
      1,
      ownerEpoch,
      previousOwner.control_server_time_ms,
      previousOwner.initial_control_server_time_ms,
      leaseTtl
    }
  end

  if seenInstances[string.lower(ARGV[5])] then return {-1, 0, 0, 0, 0} end
  local contender = make_instance(base, ARGV[3], ARGV[4], ARGV[5], ownerEpoch, now, "contender")
  contender.observed_owner_node = previousOwner.node
  local encodedContender = encode_table(contender)
  if not encodedContender then return {-1, 0, 0, 0, 0} end
  local contenderField = history_field(ARGV[3], ARGV[2], ARGV[5], ownerEpoch) .. "/contender"
  write_instance(protected, contenderField, encodedContender, now, retention, limit)
  return {
    0,
    ownerEpoch,
    previousOwner.control_server_time_ms,
    previousOwner.initial_control_server_time_ms,
    leaseTtl
  }
end

if seenInstances[string.lower(ARGV[5])] then return {-1, 0, 0, 0, 0} end
if highWater >= MAX_SAFE then return {-1, 0, 0, 0, 0} end
local nextEpoch = highWater + 1
local instance = make_instance(base, ARGV[3], ARGV[4], ARGV[5], nextEpoch, now, "owner")
local owner, roster = make_owner(instance, now, ttl)
local encodedOwner = encode_table(owner)
local encodedRoster = encode_table(roster)
local encodedInstance = encode_table(instance)
if not encodedOwner or not encodedRoster or not encodedInstance then
  return {-1, 0, 0, 0, 0}
end
local field = history_field(ARGV[3], ARGV[2], ARGV[5], nextEpoch)

local encodedExpired = nil
local expiredField = nil
if previousOwner then
  local expired = copy_table(previousOwner)
  expired.status = "expired"
  expired.ts = now
  expired.lease_expires_at = nil
  encodedExpired = encode_table(expired)
  expiredField = history_field(
    previousOwner.authority_scope,
    previousOwner.node,
    previousOwner.instance_id,
    previousOwner.control_epoch
  )
  if not encodedExpired then return {-1, 0, 0, 0, 0} end
end

redis.call("incr", KEYS[2])
redis.call("psetex", KEYS[1], ttl, ARGV[1])
if encodedExpired then
  write_instance(protected, expiredField, encodedExpired, now, retention, limit)
end
redis.call("hset", KEYS[3], ARGV[3], encodedOwner)
write_instance(protected, field, encodedInstance, now, retention, limit)
redis.call("hset", KEYS[5], ARGV[3], encodedRoster)
return {1, nextEpoch, now, now, ttl}
`

const RENEW_AND_PUBLISH = `${LUA_COMMON}
-- arena.worker-ownership.renew@2
local now = now_ms()
if not safe_integer(now, 1) or now + LEASE_TTL > MAX_SAFE then
  return {-1, 0, 0, 0, 0}
end
if not valid_environment() then return {-1, 0, 0, 0, 0} end
local expectedEpoch = parse_counter(ARGV[7])
if not safe_integer(expectedEpoch, 1) then return {-1, 0, 0, 0, 0} end
local base = decode_table(ARGV[8])
if not valid_base(base, ARGV[2], ARGV[4]) then return {-1, 0, 0, 0, 0} end
local ttl = tonumber(ARGV[6])
local retention = tonumber(ARGV[10])
local limit = tonumber(ARGV[11])
local highWater = parse_counter(redis.call("get", KEYS[2]))
if highWater == nil or highWater < expectedEpoch then return {-1, 0, 0, 0, 0} end
local protected, activeNodeHighWater = collect_protected(ARGV[2])
if not protected then return {-1, 0, 0, 0, 0} end
if highWater < activeNodeHighWater then return {-1, 0, 0, 0, 0} end
local pairValid, owner, roster = load_pair(ARGV[3])
if not pairValid then return {-1, 0, 0, 0, 0} end
if owner and now < owner.control_server_time_ms then return {-1, 0, 0, 0, 0} end
local token = redis.call("get", KEYS[1])
if token then
  local leaseTtl = redis.call("pttl", KEYS[1])
  if leaseTtl <= 0 or leaseTtl > ttl or not valid_hex(token, 64) or
     (owner and owner.lease_expires_at <= now) then
    return {-1, 0, 0, 0, 0}
  end
end

local owned = token == ARGV[1] and owner and roster and
  owner.control_epoch == expectedEpoch and
  immutable_matches(owner, base, ARGV[2], ARGV[3], ARGV[4], ARGV[5])
if not owned then
  local fenced = make_instance(base, ARGV[3], ARGV[4], ARGV[5], expectedEpoch, now, "fenced")
  local encodedFenced = encode_table(fenced)
  if not encodedFenced then return {-1, 0, 0, 0, 0} end
  local fencedField = history_field(ARGV[3], ARGV[2], ARGV[5], expectedEpoch) ..
    "/fenced/" .. tostring(now)
  write_instance(protected, fencedField, encodedFenced, now, retention, limit)
  return {
    0,
    expectedEpoch,
    owner and owner.control_server_time_ms or now,
    owner and owner.initial_control_server_time_ms or now,
    0
  }
end

local updatedOwner, updatedRoster, instance = refresh_owner(owner, base, now, ttl)
local encodedOwner = encode_table(updatedOwner)
local encodedRoster = encode_table(updatedRoster)
local encodedInstance = encode_table(instance)
if not encodedOwner or not encodedRoster or not encodedInstance then
  return {-1, 0, 0, 0, 0}
end
local field = history_field(ARGV[3], ARGV[2], ARGV[5], expectedEpoch)
write_instance(protected, field, encodedInstance, now, retention, limit)
redis.call("hset", KEYS[3], ARGV[3], encodedOwner)
redis.call("hset", KEYS[5], ARGV[3], encodedRoster)
local extended = redis.call("pexpire", KEYS[1], ttl)
if extended ~= 1 then
  return {
    0,
    expectedEpoch,
    owner.control_server_time_ms,
    owner.initial_control_server_time_ms,
    0
  }
end
return {1, expectedEpoch, now, owner.initial_control_server_time_ms, ttl}
`

const RELEASE_OWNERSHIP = `${LUA_COMMON}
-- arena.worker-ownership.release@2
local now = now_ms()
if not safe_integer(now, 1) or now + LEASE_TTL > MAX_SAFE then
  return {-1, 0, 0, 0, 0}
end
if not valid_environment() then return {-1, 0, 0, 0, 0} end
local expectedEpoch = parse_counter(ARGV[7])
if not safe_integer(expectedEpoch, 1) then return {-1, 0, 0, 0, 0} end
local base = decode_table(ARGV[8])
if not valid_base(base, ARGV[2], ARGV[4]) then return {-1, 0, 0, 0, 0} end
local ttl = tonumber(ARGV[6])
local retention = tonumber(ARGV[10])
local limit = tonumber(ARGV[11])
local highWater = parse_counter(redis.call("get", KEYS[2]))
if highWater == nil or highWater < expectedEpoch then return {-1, 0, 0, 0, 0} end
local protected, activeNodeHighWater = collect_protected(ARGV[2])
if not protected then return {-1, 0, 0, 0, 0} end
if highWater < activeNodeHighWater then return {-1, 0, 0, 0, 0} end
local pairValid, owner, roster = load_pair(ARGV[3])
if not pairValid then return {-1, 0, 0, 0, 0} end
if owner and now < owner.control_server_time_ms then return {-1, 0, 0, 0, 0} end
local token = redis.call("get", KEYS[1])
if token then
  local leaseTtl = redis.call("pttl", KEYS[1])
  if leaseTtl <= 0 or leaseTtl > ttl or not valid_hex(token, 64) or
     (owner and owner.lease_expires_at <= now) then
    return {-1, 0, 0, 0, 0}
  end
end

local owned = token == ARGV[1] and owner and roster and
  owner.control_epoch == expectedEpoch and
  immutable_matches(owner, base, ARGV[2], ARGV[3], ARGV[4], ARGV[5])
if not owned then
  local fenced = make_instance(base, ARGV[3], ARGV[4], ARGV[5], expectedEpoch, now, "fenced")
  local encodedFenced = encode_table(fenced)
  if not encodedFenced then return {-1, 0, 0, 0, 0} end
  local fencedField = history_field(ARGV[3], ARGV[2], ARGV[5], expectedEpoch) ..
    "/fenced/" .. tostring(now)
  write_instance(protected, fencedField, encodedFenced, now, retention, limit)
  return {
    0,
    expectedEpoch,
    owner and owner.control_server_time_ms or now,
    owner and owner.initial_control_server_time_ms or now,
    0
  }
end

local released = copy_table(owner)
released.status = "released"
released.ts = now
released.lease_expires_at = nil
local encodedReleased = encode_table(released)
if not encodedReleased then return {-1, 0, 0, 0, 0} end
local field = history_field(ARGV[3], ARGV[2], ARGV[5], expectedEpoch)
write_instance(protected, field, encodedReleased, now, retention, limit)
redis.call("hdel", KEYS[5], ARGV[3])
redis.call("hdel", KEYS[3], ARGV[3])
local deleted = redis.call("del", KEYS[1])
if deleted ~= 1 then
  return {
    0,
    expectedEpoch,
    owner.control_server_time_ms,
    owner.initial_control_server_time_ms,
    0
  }
end
return {
  1,
  expectedEpoch,
  owner.control_server_time_ms,
  owner.initial_control_server_time_ms,
  0
}
`

export interface WorkerOwnershipRedis {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}

export interface WorkerOwnershipHeartbeatInput {
  attempt_bound_capture: boolean
  disk?: number
  node: string
  pid: number
  regions: WorkerOwnershipRegion[]
  release_id: string
  sha: string
}

export interface WorkerOwnershipProof {
  readonly authorityScope: WorkerAuthorityScope
  readonly controlEpoch: number
  readonly controlServerTimeMs: number
  readonly initialControlServerTimeMs: number
  readonly instanceId: string
  readonly nodeId: string
  readonly region: WorkerOwnershipRegion
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
      authorityScope: WorkerAuthorityScope
      instanceId: string
      observedControlEpoch: number
      observedControlServerTimeMs: number
      region: WorkerOwnershipRegion
      status: 'contended'
    }
  | { lease: WorkerOwnershipLease; status: 'owned' }

interface WorkerOwnershipIdentity {
  authorityScope: WorkerAuthorityScope
  instanceId: string
  ownerToken: string
}

interface AcquireWorkerOwnershipOptions {
  heartbeat: WorkerOwnershipHeartbeatInput
  identity?: WorkerOwnershipIdentity
  monotonicNow?: () => number
  redis: WorkerOwnershipRedis
}

function validateIdentity(
  identity: WorkerOwnershipIdentity,
  authorityScope: WorkerAuthorityScope
): void {
  if (identity.authorityScope !== authorityScope) {
    throw new Error('[ingest-worker] worker instance identity scope cannot change')
  }
  if (!INSTANCE_ID.test(identity.instanceId)) {
    throw new Error('[ingest-worker] worker instance identity is malformed')
  }
  if (!OWNER_TOKEN.test(identity.ownerToken) || identity.ownerToken === ZERO_64) {
    throw new Error('[ingest-worker] worker owner token is malformed')
  }
}

function createIdentity(authorityScope: WorkerAuthorityScope): WorkerOwnershipIdentity {
  return {
    authorityScope,
    instanceId: randomUUID(),
    ownerToken: randomBytes(32).toString('hex'),
  }
}

export function workerOwnershipKeys(node: string, region: WorkerOwnershipRegion) {
  if (typeof node !== 'string' || !NODE_ID.test(node)) {
    throw new Error('[ingest-worker] unsafe worker node identity')
  }
  const authorityScope = workerAuthorityScope(region)
  return {
    epoch: `${WORKER_OWNER_EPOCH_PREFIX}${node}`,
    index: WORKER_INSTANCE_INDEX_KEY,
    instances: WORKER_INSTANCE_RECORDS_KEY,
    lease: `${WORKER_OWNER_LEASE_PREFIX}${authorityScope}`,
    owners: WORKER_OWNER_RECORDS_KEY,
    roster: WORKER_ROSTER_V4_KEY,
  } as const
}

function normalizeHeartbeat(
  heartbeat: WorkerOwnershipHeartbeatInput
): WorkerOwnershipHeartbeatInput {
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
    typeof heartbeat.node !== 'string' ||
    !NODE_ID.test(heartbeat.node) ||
    !Number.isSafeInteger(heartbeat.pid) ||
    heartbeat.pid <= 0 ||
    !Array.isArray(heartbeat.regions) ||
    heartbeat.regions.length !== 1 ||
    (heartbeat.regions[0] !== 'local' && heartbeat.regions[0] !== 'vps_sg') ||
    typeof heartbeat.sha !== 'string' ||
    !COMMIT_SHA.test(heartbeat.sha) ||
    heartbeat.sha === ZERO_COMMIT_SHA ||
    typeof heartbeat.release_id !== 'string' ||
    !RELEASE_ID.test(heartbeat.release_id) ||
    heartbeat.release_id === ZERO_64 ||
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
    regions: [heartbeat.regions[0]],
    release_id: heartbeat.release_id,
    sha: heartbeat.sha,
  }
  if (heartbeat.disk !== undefined) exact.disk = heartbeat.disk
  return exact
}

function serializeHeartbeat(heartbeat: WorkerOwnershipHeartbeatInput): string {
  const encoded = JSON.stringify(heartbeat)
  if (encoded.length > 4_096) {
    throw new Error('[ingest-worker] worker ownership heartbeat is oversized')
  }
  return encoded
}

function parseScriptResult(value: unknown): {
  controlEpoch: number
  controlServerTimeMs: number
  initialControlServerTimeMs: number
  leaseRemainingMs: number
  owned: boolean
} {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new Error('[ingest-worker] worker ownership script returned a malformed result')
  }
  const parseInteger = (raw: unknown): number | null => {
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return null
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  const status = parseInteger(value[0])
  const controlEpoch = parseInteger(value[1])
  const controlServerTimeMs = parseInteger(value[2])
  const initialControlServerTimeMs = parseInteger(value[3])
  const leaseRemainingMs = parseInteger(value[4])
  if (
    (status !== 0 && status !== 1) ||
    controlEpoch === null ||
    controlEpoch < 1 ||
    controlEpoch > MAX_CONTROL_EPOCH ||
    controlServerTimeMs === null ||
    controlServerTimeMs <= 0 ||
    controlServerTimeMs > MAX_CONTROL_EPOCH ||
    initialControlServerTimeMs === null ||
    initialControlServerTimeMs <= 0 ||
    initialControlServerTimeMs > controlServerTimeMs ||
    leaseRemainingMs === null ||
    leaseRemainingMs < 0 ||
    leaseRemainingMs > WORKER_OWNER_LEASE_TTL_MS
  ) {
    throw new Error('[ingest-worker] worker ownership script returned an invalid result')
  }
  return {
    controlEpoch,
    controlServerTimeMs,
    initialControlServerTimeMs,
    leaseRemainingMs,
    owned: status === 1,
  }
}

function scriptArgs(
  keys: ReturnType<typeof workerOwnershipKeys>,
  identity: WorkerOwnershipIdentity,
  heartbeat: WorkerOwnershipHeartbeatInput,
  authorityScope: WorkerAuthorityScope,
  region: WorkerOwnershipRegion,
  controlEpoch?: number
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
    authorityScope,
    region,
    identity.instanceId,
    String(WORKER_OWNER_LEASE_TTL_MS),
    controlEpoch === undefined ? '' : String(controlEpoch),
    serializeHeartbeat(heartbeat),
    WORKER_OWNERSHIP_CONTRACT,
    String(WORKER_INSTANCE_RECORD_RETENTION_MS),
    String(WORKER_INSTANCE_RECORD_LIMIT),
  ]
}

async function runOwnershipScript(
  redis: WorkerOwnershipRedis,
  script: string,
  args: string[],
  operation: 'acquire' | 'release' | 'renew'
): Promise<unknown> {
  try {
    return await redis.eval(script, 6, ...args)
  } catch {
    // Some Redis clients attach the complete failed command (including ARGV)
    // to their error. Never let the private owner token cross this boundary.
    throw new Error(`[ingest-worker] worker ownership ${operation} Redis command failed`)
  }
}

function sameImmutableHeartbeat(
  left: WorkerOwnershipHeartbeatInput,
  right: WorkerOwnershipHeartbeatInput
): boolean {
  return (
    left.node === right.node &&
    left.pid === right.pid &&
    left.regions[0] === right.regions[0] &&
    left.release_id === right.release_id &&
    left.sha === right.sha
  )
}

/**
 * Register this boot and atomically claim one registered region scope. The
 * private token stays inside the closure and Redis command boundary; it never
 * enters published records, errors, or the public proof.
 */
export async function acquireWorkerOwnership({
  heartbeat,
  identity,
  monotonicNow = () => performance.now(),
  redis,
}: AcquireWorkerOwnershipOptions): Promise<WorkerOwnershipAcquireResult> {
  const initialHeartbeat = normalizeHeartbeat(heartbeat)
  const region = initialHeartbeat.regions[0]
  const authorityScope = workerAuthorityScope(region)
  const ownerIdentity = { ...(identity ?? createIdentity(authorityScope)) }
  validateIdentity(ownerIdentity, authorityScope)
  const nodeId = initialHeartbeat.node
  const keys = workerOwnershipKeys(nodeId, region)
  const acquireStartedAt = monotonicNow()
  const acquired = parseScriptResult(
    await runOwnershipScript(
      redis,
      ACQUIRE_OWNERSHIP,
      scriptArgs(keys, ownerIdentity, initialHeartbeat, authorityScope, region),
      'acquire'
    )
  )
  if (!acquired.owned) {
    return {
      authorityScope,
      instanceId: ownerIdentity.instanceId,
      observedControlEpoch: acquired.controlEpoch,
      observedControlServerTimeMs: acquired.controlServerTimeMs,
      region,
      status: 'contended',
    }
  }
  const acquiredSafetyWindowMs = acquired.leaseRemainingMs - WORKER_OWNER_SAFETY_MARGIN_MS
  if (acquiredSafetyWindowMs <= 0 || monotonicNow() - acquireStartedAt >= acquiredSafetyWindowMs) {
    throw new Error('[ingest-worker] worker ownership proof arrived outside its safe lease window')
  }

  type LeaseState = 'owned' | 'releasing' | 'released' | 'fenced'
  let state: LeaseState = 'owned'
  let latestHeartbeat = initialHeartbeat
  let selfFenceDeadlineAt = acquireStartedAt + acquiredSafetyWindowMs
  let watchdog: NodeJS.Timeout | undefined
  let operationTail: Promise<void> = Promise.resolve()
  let releasePromise: Promise<boolean> | undefined
  const abortController = new AbortController()
  let proof: WorkerOwnershipProof = {
    authorityScope,
    controlEpoch: acquired.controlEpoch,
    controlServerTimeMs: acquired.controlServerTimeMs,
    initialControlServerTimeMs: acquired.initialControlServerTimeMs,
    instanceId: ownerIdentity.instanceId,
    nodeId,
    region,
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
  const scheduleWatchdog = (proofStartedAt: number, leaseRemainingMs: number) => {
    const safetyWindowMs = leaseRemainingMs - WORKER_OWNER_SAFETY_MARGIN_MS
    selfFenceDeadlineAt = proofStartedAt + safetyWindowMs
    clearWatchdog()
    const remaining = selfFenceDeadlineAt - monotonicNow()
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
    if (monotonicNow() >= selfFenceDeadlineAt) {
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
  scheduleWatchdog(acquireStartedAt, acquired.leaseRemainingMs)

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
          const normalizedHeartbeat = normalizeHeartbeat(nextHeartbeat)
          if (!sameImmutableHeartbeat(initialHeartbeat, normalizedHeartbeat)) {
            throw new Error('[ingest-worker] worker ownership identity evidence cannot change')
          }
          const result = parseScriptResult(
            await runOwnershipScript(
              redis,
              RENEW_AND_PUBLISH,
              scriptArgs(
                keys,
                ownerIdentity,
                normalizedHeartbeat,
                authorityScope,
                region,
                proof.controlEpoch
              ),
              'renew'
            )
          )
          if (result.controlEpoch !== proof.controlEpoch) {
            throw new Error('[ingest-worker] worker ownership renewal epoch changed')
          }
          if (result.controlServerTimeMs < proof.controlServerTimeMs) {
            throw new Error('[ingest-worker] worker ownership renewal server time regressed')
          }
          if (state !== 'owned') return false
          if (!result.owned) {
            fence(new Error('[ingest-worker] worker ownership renewal was rejected'))
            return false
          }
          if (result.initialControlServerTimeMs !== proof.initialControlServerTimeMs) {
            throw new Error('[ingest-worker] worker ownership initial control time changed')
          }
          const renewedSafetyWindowMs = result.leaseRemainingMs - WORKER_OWNER_SAFETY_MARGIN_MS
          if (
            renewedSafetyWindowMs <= 0 ||
            monotonicNow() - renewStartedAt >= renewedSafetyWindowMs
          ) {
            fence(new Error('[ingest-worker] worker ownership renewal arrived too late'))
            return false
          }
          latestHeartbeat = normalizedHeartbeat
          proof = { ...proof, controlServerTimeMs: result.controlServerTimeMs }
          scheduleWatchdog(renewStartedAt, result.leaseRemainingMs)
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
            await runOwnershipScript(
              redis,
              RELEASE_OWNERSHIP,
              scriptArgs(
                keys,
                ownerIdentity,
                latestHeartbeat,
                authorityScope,
                region,
                proof.controlEpoch
              ),
              'release'
            )
          )
          if (result.controlEpoch !== proof.controlEpoch) {
            throw new Error('[ingest-worker] worker ownership release epoch changed')
          }
          if (
            result.owned &&
            result.initialControlServerTimeMs !== proof.initialControlServerTimeMs
          ) {
            throw new Error('[ingest-worker] worker ownership initial control time changed')
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
