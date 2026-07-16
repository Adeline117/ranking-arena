export type LatestWriteResult = 'saved' | 'failed' | 'stale'

type ValueSetter<Value> = (value: Value) => void

type QueueState<Value, Context> = {
  persisted: Value
  desired: Value
  setter: ValueSetter<Value>
  context: Context
  epoch: number
  task: Promise<void> | null
}

export type LatestWriteQueueOptions<Key, Value, Context> = {
  write: (key: Key, value: Value, context: Context) => Promise<LatestWriteResult>
  onPersisted: (key: Key, value: Value) => void
  onFailed: (key: Key) => void
  onSaved: (key: Key) => void
}

/**
 * Serializes writes per key and retains only the latest requested value.
 * Invalidating the queue is an identity boundary: completions from the old
 * epoch are ignored and cannot roll back or toast in the new viewer.
 */
export class LatestWriteQueue<Key, Value, Context> {
  private readonly states = new Map<Key, QueueState<Value, Context>>()
  private epoch = 0

  constructor(private readonly options: LatestWriteQueueOptions<Key, Value, Context>) {}

  invalidate(): void {
    this.epoch += 1
    this.states.clear()
  }

  enqueue(
    key: Key,
    value: Value,
    previousValue: Value,
    setter: ValueSetter<Value>,
    context: Context
  ): Promise<void> {
    let state = this.states.get(key)
    if (!state || state.epoch !== this.epoch) {
      state = {
        persisted: previousValue,
        desired: value,
        setter,
        context,
        epoch: this.epoch,
        task: null,
      }
      this.states.set(key, state)
    } else {
      state.desired = value
      state.setter = setter
      state.context = context
    }

    if (!state.task) {
      const task = this.drain(key, state)
      state.task = task
      const clearTask = () => {
        if (state?.task === task) state.task = null
      }
      void task.then(clearTask, clearTask)
    }
    return state.task
  }

  private isCurrent(key: Key, state: QueueState<Value, Context>): boolean {
    return state.epoch === this.epoch && this.states.get(key) === state
  }

  private async drain(key: Key, state: QueueState<Value, Context>): Promise<void> {
    let savedAny = false
    while (this.isCurrent(key, state)) {
      while (this.isCurrent(key, state) && !Object.is(state.persisted, state.desired)) {
        const targetValue = state.desired
        const context = state.context
        let result: LatestWriteResult
        try {
          result = await this.options.write(key, targetValue, context)
        } catch {
          result = 'failed'
        }

        if (!this.isCurrent(key, state) || result === 'stale') return

        if (result === 'failed') {
          // A newer intent supersedes a failed in-flight write. Otherwise the UI
          // returns to the last value positively acknowledged by the server.
          if (Object.is(state.desired, targetValue)) {
            state.desired = state.persisted
            state.setter(state.persisted)
            this.options.onFailed(key)
            // Callbacks may enqueue synchronously while this task is still the
            // key's owner. Re-check desired before allowing the task to settle.
            if (Object.is(state.persisted, state.desired)) return
          }
          continue
        }

        state.persisted = targetValue
        savedAny = true
        this.options.onPersisted(key, targetValue)
      }

      if (!this.isCurrent(key, state)) return
      if (savedAny) {
        savedAny = false
        this.options.onSaved(key)
        // onSaved/onPersisted may synchronously enqueue a newer intent. Keep
        // the same promise alive until that intent is also drained.
        if (!Object.is(state.persisted, state.desired)) continue
      }
      return
    }
  }
}
