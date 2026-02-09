// Circuit Breaker with Redis-backed state
// States: CLOSED (normal) → OPEN (broken) → HALF_OPEN (probing)

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const HEALTH_KEY_PREFIX = 'arena:health:';

class CircuitBreaker {
  constructor(redis) {
    this.redis = redis;
  }

  _key(jobName) {
    return `${HEALTH_KEY_PREFIX}${jobName}`;
  }

  async getState(jobName) {
    const data = await this.redis.hgetall(this._key(jobName));
    if (!data || !data.consecutiveFailures) {
      return {
        state: 'CLOSED',
        consecutiveFailures: 0,
        lastSuccess: null,
        lastError: null,
        lastErrorMessage: null,
        avgLatency: 0,
        openedAt: null,
      };
    }
    const failures = parseInt(data.consecutiveFailures) || 0;
    const openedAt = parseInt(data.openedAt) || 0;

    let state = 'CLOSED';
    if (failures >= FAILURE_THRESHOLD && openedAt) {
      const elapsed = Date.now() - openedAt;
      state = elapsed >= OPEN_DURATION_MS ? 'HALF_OPEN' : 'OPEN';
    }

    return {
      state,
      consecutiveFailures: failures,
      lastSuccess: data.lastSuccess || null,
      lastError: data.lastError || null,
      lastErrorMessage: data.lastErrorMessage || null,
      avgLatency: parseFloat(data.avgLatency) || 0,
      openedAt: openedAt || null,
    };
  }

  async canExecute(jobName) {
    const s = await this.getState(jobName);
    if (s.state === 'CLOSED' || s.state === 'HALF_OPEN') return true;
    return false; // OPEN → skip
  }

  async recordSuccess(jobName, latencyMs) {
    const key = this._key(jobName);
    const now = new Date().toISOString();
    const oldAvg = parseFloat(await this.redis.hget(key, 'avgLatency') || '0');
    const newAvg = oldAvg ? (oldAvg * 0.8 + latencyMs * 0.2) : latencyMs;

    await this.redis.hmset(key, {
      consecutiveFailures: 0,
      lastSuccess: now,
      avgLatency: newAvg.toFixed(1),
      openedAt: 0,
    });
  }

  async recordFailure(jobName, errorMessage) {
    const key = this._key(jobName);
    const now = new Date().toISOString();
    const failures = (parseInt(await this.redis.hget(key, 'consecutiveFailures') || '0')) + 1;

    const update = {
      consecutiveFailures: failures,
      lastError: now,
      lastErrorMessage: (errorMessage || '').slice(0, 500),
    };

    if (failures >= FAILURE_THRESHOLD) {
      const openedAt = parseInt(await this.redis.hget(key, 'openedAt') || '0');
      if (!openedAt) {
        update.openedAt = Date.now();
      }
    }

    await this.redis.hmset(key, update);
    return failures;
  }

  async getAllStates() {
    const keys = await this.redis.keys(`${HEALTH_KEY_PREFIX}*`);
    const states = {};
    for (const key of keys) {
      const name = key.replace(HEALTH_KEY_PREFIX, '');
      states[name] = await this.getState(name);
    }
    return states;
  }
}

module.exports = { CircuitBreaker, FAILURE_THRESHOLD, HEALTH_KEY_PREFIX };
