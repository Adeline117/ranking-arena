/**
 * Short-lived evidence that a native worker boot intends to reclaim its own
 * region. This module is deliberately inert: callers must explicitly publish,
 * read, renew, and remove records. It does not start timers or consumers.
 */

export const NATIVE_RETURN_INTENT_CONTRACT = 'arena.native-return-intent@1' as const
export const NATIVE_RETURN_INTENT_HASH_KEY = 'arena:{worker}:native-intents:v1'
export const NATIVE_RETURN_INTENT_EXPIRY_KEY = 'arena:{worker}:native-intents-expiry:v1'
export const NATIVE_RETURN_INTENT_RENEW_MS = 10_000
export const NATIVE_RETURN_INTENT_RENEW_INTERVAL_MS = NATIVE_RETURN_INTENT_RENEW_MS
export const NATIVE_RETURN_INTENT_TTL_MS = 45_000
export const NATIVE_RETURN_INTENT_PRUNE_LIMIT = 128
export const NATIVE_RETURN_INTENT_READ_LIMIT = 128

const MIN_TTL_MS = NATIVE_RETURN_INTENT_RENEW_MS * 3
const MAX_TTL_MS = 5 * 60_000
const MAX_PRUNE_LIMIT = 512
const MAX_READ_LIMIT = 512
const MAX_PID = 2_147_483_647
const MAX_SAFE_REDIS_INTEGER = 9_007_199_254_740_000
const MAX_ENCODED_INTENT_BYTES = 1_024

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RELEASE_ID = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ZERO_RELEASE_ID = '0'.repeat(64)
const ZERO_COMMIT_SHA = '0'.repeat(40)

export type NativeReturnIntentRegion = 'local' | 'vps_sg'

export interface NativeReturnIntentIdentity {
  readonly boot_id: string
  readonly executionRegion: NativeReturnIntentRegion
  readonly node: string
  readonly pid: number
  readonly region: NativeReturnIntentRegion
  readonly release_id: string
  readonly sha: string
}

export interface NativeReturnIntent extends NativeReturnIntentIdentity {
  readonly contract: typeof NATIVE_RETURN_INTENT_CONTRACT
  readonly expires: number
  readonly server_time: number
}

export interface NativeReturnIntentRedis {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}

export type NativeReturnIntentErrorCode =
  | 'identity_malformed'
  | 'parameters_malformed'
  | 'publish_redis_failed'
  | 'publish_rejected'
  | 'publish_result_malformed'
  | 'read_redis_failed'
  | 'read_result_malformed'
  | 'region_mismatch'
  | 'remove_redis_failed'
  | 'remove_result_malformed'

export class NativeReturnIntentError extends Error {
  readonly code: NativeReturnIntentErrorCode

  constructor(code: NativeReturnIntentErrorCode) {
    super(`[ingest-worker] native return intent rejected (${code})`)
    this.name = 'NativeReturnIntentError'
    this.code = code
  }
}

export interface PublishNativeReturnIntentOptions {
  readonly identity: NativeReturnIntentIdentity
  readonly pruneLimit?: number
  readonly redis: NativeReturnIntentRedis
  readonly ttlMs?: number
}

export interface ReadFreshNativeReturnIntentsOptions {
  readonly pruneLimit?: number
  readonly readLimit?: number
  readonly redis: NativeReturnIntentRedis
  readonly targetRegion: NativeReturnIntentRegion
}

export interface RemoveNativeReturnIntentOptions {
  readonly boot_id: string
  readonly node: string
  readonly redis: NativeReturnIntentRedis
  readonly region: NativeReturnIntentRegion
}

const LUA_COMMON = `
local MAX_SAFE = 9007199254740000
local MIN_TTL = 30000
local MAX_TTL = 300000
local MAX_PRUNE = 512
local MAX_READ = 512
local MAX_SCAN = 1024
local MAX_PID = 2147483647
local MAX_ENCODED = 1024
local CONTRACT = "arena.native-return-intent@1"
local HASH_KEY = "arena:{worker}:native-intents:v1"
local EXPIRY_KEY = "arena:{worker}:native-intents-expiry:v1"

local function key_type(key)
  local result = redis.call("type", key)
  if type(result) == "table" then return result.ok end
  return result
end
local function valid_keys()
  if #KEYS ~= 2 or KEYS[1] ~= HASH_KEY or KEYS[2] ~= EXPIRY_KEY then return false end
  local hashType = key_type(KEYS[1])
  local expiryType = key_type(KEYS[2])
  return (hashType == "none" or hashType == "hash") and
    (expiryType == "none" or expiryType == "zset")
end
local function now_ms()
  local value = redis.call("time")
  if type(value) ~= "table" or #value ~= 2 then return nil end
  local seconds = tonumber(value[1])
  local micros = tonumber(value[2])
  if not seconds or not micros then return nil end
  local now = seconds * 1000 + math.floor(micros / 1000)
  if now < 1 or now > MAX_SAFE or now ~= math.floor(now) then return nil end
  return now
end
local function safe_integer(value, minimum, maximum)
  return type(value) == "number" and value >= minimum and value <= maximum and
    value == math.floor(value)
end
local function parse_integer(value, minimum, maximum)
  if type(value) ~= "string" then return nil end
  if value ~= "0" and string.match(value, "^[1-9][0-9]*$") == nil then return nil end
  local parsed = tonumber(value)
  if not safe_integer(parsed, minimum, maximum) then return nil end
  return parsed
end
local function valid_hex(value, length)
  return type(value) == "string" and string.len(value) == length and
    string.find(value, "[^0-9a-f]") == nil and value ~= string.rep("0", length)
end
local function valid_node(value)
  return type(value) == "string" and string.len(value) >= 1 and
    string.len(value) <= 128 and
    string.match(value, "^[A-Za-z0-9][A-Za-z0-9._%-]*$") ~= nil
end
local function valid_region(value)
  return value == "local" or value == "vps_sg"
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
  return string.len(compact) == 32 and string.find(compact, "[^0-9a-f]") == nil and
    string.find("12345", string.sub(value, 15, 15), 1, true) ~= nil and
    string.find("89ab", string.sub(value, 20, 20), 1, true) ~= nil
end
local function intent_field(region, node, bootId)
  return "region:" .. region .. "/" .. node .. "/" .. bootId
end
local function decode_record(raw)
  if type(raw) ~= "string" or string.len(raw) > MAX_ENCODED then return nil end
  local decoded, record = pcall(cjson.decode, raw)
  if not decoded or type(record) ~= "table" then return nil end
  return record
end
local function valid_record(record, expectedField, expectedRegion, score, now, requireFresh)
  if type(record) ~= "table" then return false end
  local allowed = {
    boot_id = true,
    contract = true,
    executionRegion = true,
    expires = true,
    node = true,
    pid = true,
    region = true,
    release_id = true,
    server_time = true,
    sha = true
  }
  local count = 0
  for key, _ in pairs(record) do
    if not allowed[key] then return false end
    count = count + 1
  end
  if count ~= 10 or record.contract ~= CONTRACT or not valid_region(record.region) or
     record.executionRegion ~= record.region or record.region ~= expectedRegion or
     not valid_node(record.node) or
     not safe_integer(record.pid, 1, MAX_PID) or not valid_uuid(record.boot_id) or
     not valid_hex(record.release_id, 64) or not valid_hex(record.sha, 40) or
     not safe_integer(record.server_time, 1, MAX_SAFE) or
     not safe_integer(record.expires, 1, MAX_SAFE) or
     record.expires - record.server_time < MIN_TTL or
     record.expires - record.server_time > MAX_TTL or record.server_time > now or
     intent_field(record.region, record.node, record.boot_id) ~= expectedField then
    return false
  end
  if score ~= nil and record.expires ~= score then return false end
  if requireFresh and record.expires <= now then return false end
  return true
end
local function prune_expired(now, limit)
  local expired = redis.call("zrangebyscore", KEYS[2], "-inf", now, "limit", 0, limit)
  if #expired > 0 then
    redis.call("hdel", KEYS[1], unpack(expired))
    redis.call("zrem", KEYS[2], unpack(expired))
  end
  return #expired
end
`

const PUBLISH_OR_RENEW = `${LUA_COMMON}
-- arena.native-return-intent.publish-or-renew@1
if not valid_keys() or #ARGV ~= 10 or ARGV[1] ~= CONTRACT or
   not valid_region(ARGV[2]) or ARGV[3] ~= ARGV[2] or not valid_node(ARGV[4]) or
   not parse_integer(ARGV[5], 1, MAX_PID) or not valid_uuid(ARGV[6]) or
   not valid_hex(ARGV[7], 64) or not valid_hex(ARGV[8], 40) then
  return redis.error_reply("native return intent publish arguments rejected")
end
local ttl = parse_integer(ARGV[9], MIN_TTL, MAX_TTL)
local pruneLimit = parse_integer(ARGV[10], 1, MAX_PRUNE)
if not ttl or not pruneLimit then
  return redis.error_reply("native return intent publish parameters rejected")
end
local now = now_ms()
if not now or now + ttl > MAX_SAFE then
  return redis.error_reply("native return intent Redis time rejected")
end
local pruned = prune_expired(now, pruneLimit)
local field = intent_field(ARGV[2], ARGV[4], ARGV[6])
local previousRaw = redis.call("hget", KEYS[1], field)
local previousScore = redis.call("zscore", KEYS[2], field)
if (previousRaw and not previousScore) or (previousScore and not previousRaw) then
  return {CONTRACT, "invalid", now, pruned}
end
if previousRaw then
  local previous = decode_record(previousRaw)
  local score = tonumber(previousScore)
  if not score or not valid_record(previous, field, ARGV[2], score, now, true) then
    return {CONTRACT, "invalid", now, pruned}
  end
  if previous.executionRegion ~= ARGV[3] or previous.node ~= ARGV[4] or
     previous.pid ~= tonumber(ARGV[5]) or previous.boot_id ~= ARGV[6] or
     previous.release_id ~= ARGV[7] or previous.sha ~= ARGV[8] then
    return {CONTRACT, "conflict", now, pruned}
  end
end
local expires = now + ttl
local record = {
  boot_id = ARGV[6],
  contract = CONTRACT,
  executionRegion = ARGV[3],
  expires = expires,
  node = ARGV[4],
  pid = tonumber(ARGV[5]),
  region = ARGV[2],
  release_id = ARGV[7],
  server_time = now,
  sha = ARGV[8]
}
local encodedOk, encoded = pcall(cjson.encode, record)
if not encodedOk or type(encoded) ~= "string" or string.len(encoded) > MAX_ENCODED then
  return redis.error_reply("native return intent encoding rejected")
end
redis.call("hset", KEYS[1], field, encoded)
redis.call("zadd", KEYS[2], expires, field)
return {CONTRACT, "ok", now, expires, field, encoded, pruned}
`

const READ_FRESH = `${LUA_COMMON}
-- arena.native-return-intent.read-fresh@1
if not valid_keys() or #ARGV ~= 4 or ARGV[1] ~= CONTRACT or not valid_region(ARGV[2]) then
  return redis.error_reply("native return intent read arguments rejected")
end
local pruneLimit = parse_integer(ARGV[3], 1, MAX_PRUNE)
local readLimit = parse_integer(ARGV[4], 1, MAX_READ)
if not pruneLimit or not readLimit then
  return redis.error_reply("native return intent read parameters rejected")
end
local now = now_ms()
if not now then return redis.error_reply("native return intent Redis time rejected") end
local pruned = prune_expired(now, pruneLimit)
local members = redis.call(
  "zrangebyscore", KEYS[2], "(" .. string.format("%.0f", now), "+inf",
  "withscores", "limit", 0, MAX_SCAN + 1
)
if #members > MAX_SCAN * 2 then return {CONTRACT, "overflow", now, pruned} end
local prefix = "region:" .. ARGV[2] .. "/"
local result = {CONTRACT, "ok", now, pruned}
local count = 0
for index = 1, #members, 2 do
  local field = members[index]
  if string.sub(field, 1, string.len(prefix)) == prefix then
    count = count + 1
    if count > readLimit then return {CONTRACT, "overflow", now, pruned} end
    local score = tonumber(members[index + 1])
    local raw = redis.call("hget", KEYS[1], field)
    local record = decode_record(raw)
    if not score or not valid_record(record, field, ARGV[2], score, now, true) then
      return {CONTRACT, "invalid", now, pruned}
    end
    table.insert(result, field)
    table.insert(result, score)
    table.insert(result, raw)
  end
end
return result
`

const REMOVE_EXACT_BOOT = `${LUA_COMMON}
-- arena.native-return-intent.remove-exact-boot@1
if not valid_keys() or #ARGV ~= 4 or ARGV[1] ~= CONTRACT or
   not valid_region(ARGV[2]) or not valid_node(ARGV[3]) or not valid_uuid(ARGV[4]) then
  return redis.error_reply("native return intent remove arguments rejected")
end
local now = now_ms()
if not now then return redis.error_reply("native return intent Redis time rejected") end
local field = intent_field(ARGV[2], ARGV[3], ARGV[4])
local raw = redis.call("hget", KEYS[1], field)
local scoreRaw = redis.call("zscore", KEYS[2], field)
if not raw and not scoreRaw then return {CONTRACT, "absent", now} end
if not raw or not scoreRaw then return {CONTRACT, "invalid", now} end
local score = tonumber(scoreRaw)
local record = decode_record(raw)
if not score or not valid_record(record, field, ARGV[2], score, now, false) or
   record.node ~= ARGV[3] or record.boot_id ~= ARGV[4] then
  return {CONTRACT, "invalid", now}
end
redis.call("hdel", KEYS[1], field)
redis.call("zrem", KEYS[2], field)
return {CONTRACT, "removed", now}
`

function error(code: NativeReturnIntentErrorCode): NativeReturnIntentError {
  return new NativeReturnIntentError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  try {
    const keys = Object.keys(value)
    const allowed = new Set([...required, ...optional])
    return (
      required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      keys.every((key) => allowed.has(key)) &&
      keys.length >= required.length &&
      keys.length <= required.length + optional.length &&
      !Object.prototype.hasOwnProperty.call(value, 'toJSON')
    )
  } catch {
    return false
  }
}

function isRegion(value: unknown): value is NativeReturnIntentRegion {
  return value === 'local' || value === 'vps_sg'
}

function isPositiveSafeInteger(value: unknown, maximum = MAX_SAFE_REDIS_INTEGER): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0 && value <= maximum
}

function normalizeIdentity(value: unknown): NativeReturnIntentIdentity {
  const required = ['boot_id', 'executionRegion', 'node', 'pid', 'region', 'release_id', 'sha']
  try {
    if (!isRecord(value) || !hasExactKeys(value, required)) throw error('identity_malformed')
    const { boot_id, executionRegion, node, pid, region, release_id, sha } = value
    if (!isRegion(region) || !isRegion(executionRegion)) throw error('identity_malformed')
    if (region !== executionRegion) throw error('region_mismatch')
    if (
      typeof node !== 'string' ||
      !NODE_ID.test(node) ||
      !isPositiveSafeInteger(pid, MAX_PID) ||
      typeof boot_id !== 'string' ||
      !BOOT_ID.test(boot_id) ||
      typeof release_id !== 'string' ||
      !RELEASE_ID.test(release_id) ||
      release_id === ZERO_RELEASE_ID ||
      typeof sha !== 'string' ||
      !COMMIT_SHA.test(sha) ||
      sha === ZERO_COMMIT_SHA
    ) {
      throw error('identity_malformed')
    }
    return Object.freeze({ boot_id, executionRegion, node, pid, region, release_id, sha })
  } catch (caught) {
    if (caught instanceof NativeReturnIntentError) throw caught
    throw error('identity_malformed')
  }
}

function parseInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined
}

function validateRedis(value: unknown): value is NativeReturnIntentRedis {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof Reflect.get(value, 'eval') === 'function'
    )
  } catch {
    return false
  }
}

function option(value: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    throw error('parameters_malformed')
  }
}

function validateBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value === undefined ? fallback : value
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw error('parameters_malformed')
  }
  return candidate
}

export function nativeReturnIntentField(
  region: NativeReturnIntentRegion,
  node: string,
  boot_id: string
): string {
  if (
    !isRegion(region) ||
    typeof node !== 'string' ||
    !NODE_ID.test(node) ||
    typeof boot_id !== 'string' ||
    !BOOT_ID.test(boot_id)
  ) {
    throw error('identity_malformed')
  }
  return `region:${region}/${node}/${boot_id}`
}

function parseRecord(
  raw: unknown,
  expectedField: string,
  expectedRegion: NativeReturnIntentRegion,
  expectedScore: number,
  snapshotServerTime: number
): NativeReturnIntent {
  try {
    if (typeof raw !== 'string' || raw.length > MAX_ENCODED_INTENT_BYTES) {
      throw error('read_result_malformed')
    }
    const value: unknown = JSON.parse(raw)
    const required = [
      'boot_id',
      'contract',
      'executionRegion',
      'expires',
      'node',
      'pid',
      'region',
      'release_id',
      'server_time',
      'sha',
    ]
    if (!isRecord(value) || !hasExactKeys(value, required)) {
      throw error('read_result_malformed')
    }
    const identity = normalizeIdentity({
      boot_id: value.boot_id,
      executionRegion: value.executionRegion,
      node: value.node,
      pid: value.pid,
      region: value.region,
      release_id: value.release_id,
      sha: value.sha,
    })
    if (
      value.contract !== NATIVE_RETURN_INTENT_CONTRACT ||
      identity.region !== expectedRegion ||
      nativeReturnIntentField(identity.region, identity.node, identity.boot_id) !== expectedField ||
      !isPositiveSafeInteger(value.server_time) ||
      !isPositiveSafeInteger(value.expires) ||
      value.expires !== expectedScore ||
      value.server_time > snapshotServerTime ||
      value.expires <= snapshotServerTime ||
      value.expires - value.server_time < MIN_TTL_MS ||
      value.expires - value.server_time > MAX_TTL_MS
    ) {
      throw error('read_result_malformed')
    }
    return Object.freeze({
      ...identity,
      contract: NATIVE_RETURN_INTENT_CONTRACT,
      expires: value.expires,
      server_time: value.server_time,
    })
  } catch (caught) {
    if (caught instanceof NativeReturnIntentError && caught.code === 'read_result_malformed') {
      throw caught
    }
    throw error('read_result_malformed')
  }
}

async function runScript(
  redis: NativeReturnIntentRedis,
  script: string,
  args: string[],
  operation: 'publish' | 'read' | 'remove'
): Promise<unknown> {
  try {
    return await redis.eval(
      script,
      2,
      NATIVE_RETURN_INTENT_HASH_KEY,
      NATIVE_RETURN_INTENT_EXPIRY_KEY,
      ...args
    )
  } catch {
    throw error(`${operation}_redis_failed`)
  }
}

/** Publish or renew one boot's immutable native-return intent. */
export async function publishNativeReturnIntent(
  options: PublishNativeReturnIntentOptions
): Promise<NativeReturnIntent> {
  if (
    !isRecord(options) ||
    !hasExactKeys(options, ['identity', 'redis'], ['pruneLimit', 'ttlMs'])
  ) {
    throw error('parameters_malformed')
  }
  const redis = option(options, 'redis')
  if (!validateRedis(redis)) throw error('parameters_malformed')
  const identity = normalizeIdentity(option(options, 'identity'))
  const ttlMs = validateBoundedInteger(
    option(options, 'ttlMs'),
    NATIVE_RETURN_INTENT_TTL_MS,
    MIN_TTL_MS,
    MAX_TTL_MS
  )
  const pruneLimit = validateBoundedInteger(
    option(options, 'pruneLimit'),
    NATIVE_RETURN_INTENT_PRUNE_LIMIT,
    1,
    MAX_PRUNE_LIMIT
  )
  const result = await runScript(
    redis,
    PUBLISH_OR_RENEW,
    [
      NATIVE_RETURN_INTENT_CONTRACT,
      identity.region,
      identity.executionRegion,
      identity.node,
      String(identity.pid),
      identity.boot_id,
      identity.release_id,
      identity.sha,
      String(ttlMs),
      String(pruneLimit),
    ],
    'publish'
  )
  try {
    if (
      Array.isArray(result) &&
      result[0] === NATIVE_RETURN_INTENT_CONTRACT &&
      result[1] === 'conflict'
    ) {
      if (
        result.length !== 4 ||
        parseInteger(result[2], 1, MAX_SAFE_REDIS_INTEGER) === undefined ||
        parseInteger(result[3], 0, pruneLimit) === undefined
      ) {
        throw error('publish_result_malformed')
      }
      throw error('publish_rejected')
    }
    if (
      !Array.isArray(result) ||
      result.length !== 7 ||
      result[0] !== NATIVE_RETURN_INTENT_CONTRACT ||
      result[1] !== 'ok'
    ) {
      throw error('publish_result_malformed')
    }
    const serverTime = parseInteger(result[2], 1, MAX_SAFE_REDIS_INTEGER)
    const expires = parseInteger(result[3], 1, MAX_SAFE_REDIS_INTEGER)
    const pruned = parseInteger(result[6], 0, pruneLimit)
    const expectedField = nativeReturnIntentField(identity.region, identity.node, identity.boot_id)
    if (
      serverTime === undefined ||
      expires === undefined ||
      expires !== serverTime + ttlMs ||
      result[4] !== expectedField ||
      pruned === undefined
    ) {
      throw error('publish_result_malformed')
    }
    let record: NativeReturnIntent
    try {
      record = parseRecord(result[5], expectedField, identity.region, expires, serverTime)
    } catch {
      throw error('publish_result_malformed')
    }
    if (
      record.server_time !== serverTime ||
      record.boot_id !== identity.boot_id ||
      record.executionRegion !== identity.executionRegion ||
      record.node !== identity.node ||
      record.pid !== identity.pid ||
      record.release_id !== identity.release_id ||
      record.sha !== identity.sha
    ) {
      throw error('publish_result_malformed')
    }
    return record
  } catch (caught) {
    if (caught instanceof NativeReturnIntentError) throw caught
    throw error('publish_result_malformed')
  }
}

/** Read one Redis-TIME snapshot of all fresh intents for the target native region. */
export async function readFreshNativeReturnIntents(
  options: ReadFreshNativeReturnIntentsOptions
): Promise<readonly NativeReturnIntent[]> {
  if (
    !isRecord(options) ||
    !hasExactKeys(options, ['redis', 'targetRegion'], ['pruneLimit', 'readLimit'])
  ) {
    throw error('parameters_malformed')
  }
  const redis = option(options, 'redis')
  const targetRegion = option(options, 'targetRegion')
  if (!validateRedis(redis) || !isRegion(targetRegion)) throw error('parameters_malformed')
  const pruneLimit = validateBoundedInteger(
    option(options, 'pruneLimit'),
    NATIVE_RETURN_INTENT_PRUNE_LIMIT,
    1,
    MAX_PRUNE_LIMIT
  )
  const readLimit = validateBoundedInteger(
    option(options, 'readLimit'),
    NATIVE_RETURN_INTENT_READ_LIMIT,
    1,
    MAX_READ_LIMIT
  )
  const result = await runScript(
    redis,
    READ_FRESH,
    [NATIVE_RETURN_INTENT_CONTRACT, targetRegion, String(pruneLimit), String(readLimit)],
    'read'
  )
  try {
    if (
      !Array.isArray(result) ||
      result.length < 4 ||
      (result.length - 4) % 3 !== 0 ||
      result[0] !== NATIVE_RETURN_INTENT_CONTRACT ||
      result[1] !== 'ok'
    ) {
      throw error('read_result_malformed')
    }
    const serverTime = parseInteger(result[2], 1, MAX_SAFE_REDIS_INTEGER)
    const pruned = parseInteger(result[3], 0, pruneLimit)
    const recordCount = (result.length - 4) / 3
    if (serverTime === undefined || pruned === undefined || recordCount > readLimit) {
      throw error('read_result_malformed')
    }
    const seen = new Set<string>()
    const records: NativeReturnIntent[] = []
    for (let index = 4; index < result.length; index += 3) {
      const field = result[index]
      const score = parseInteger(result[index + 1], 1, MAX_SAFE_REDIS_INTEGER)
      if (typeof field !== 'string' || seen.has(field) || score === undefined) {
        throw error('read_result_malformed')
      }
      seen.add(field)
      records.push(parseRecord(result[index + 2], field, targetRegion, score, serverTime))
    }
    return Object.freeze(records)
  } catch (caught) {
    if (caught instanceof NativeReturnIntentError) throw caught
    throw error('read_result_malformed')
  }
}

/** Remove only the exact region/node/boot field; rolling replacement boots remain intact. */
export async function removeNativeReturnIntent(
  options: RemoveNativeReturnIntentOptions
): Promise<boolean> {
  if (!isRecord(options) || !hasExactKeys(options, ['boot_id', 'node', 'redis', 'region'])) {
    throw error('parameters_malformed')
  }
  const redis = option(options, 'redis')
  const region = option(options, 'region')
  const node = option(options, 'node')
  const bootId = option(options, 'boot_id')
  if (
    !validateRedis(redis) ||
    !isRegion(region) ||
    typeof node !== 'string' ||
    !NODE_ID.test(node) ||
    typeof bootId !== 'string' ||
    !BOOT_ID.test(bootId)
  ) {
    throw error('parameters_malformed')
  }
  const result = await runScript(
    redis,
    REMOVE_EXACT_BOOT,
    [NATIVE_RETURN_INTENT_CONTRACT, region, node, bootId],
    'remove'
  )
  try {
    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      result[0] !== NATIVE_RETURN_INTENT_CONTRACT ||
      (result[1] !== 'removed' && result[1] !== 'absent') ||
      parseInteger(result[2], 1, MAX_SAFE_REDIS_INTEGER) === undefined
    ) {
      throw error('remove_result_malformed')
    }
    return result[1] === 'removed'
  } catch (caught) {
    if (caught instanceof NativeReturnIntentError) throw caught
    throw error('remove_result_malformed')
  }
}
