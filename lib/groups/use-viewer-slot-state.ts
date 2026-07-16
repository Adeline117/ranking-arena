'use client'

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

const VIEWER_STATE_SLOT_LIMIT = 8

/**
 * Keeps asynchronous writes scoped to the viewer generation that created them.
 * A late setter from an old viewer can update only that viewer's slot, never the
 * slot currently rendered for a newer session.
 */
export function useViewerSlotState<T>(ownerKey: string, initialValue: T) {
  const currentOwnerKeyRef = useRef(ownerKey)
  currentOwnerKeyRef.current = ownerKey
  const ownerInitialValueRef = useRef({ ownerKey, value: initialValue })
  if (ownerInitialValueRef.current.ownerKey !== ownerKey) {
    ownerInitialValueRef.current = { ownerKey, value: initialValue }
  }
  const ownerInitialValue = ownerInitialValueRef.current.value

  const [ownedValues, setOwnedValues] = useState<Map<string, T>>(
    () => new Map([[ownerKey, initialValue]])
  )
  const value = ownedValues.has(ownerKey) ? (ownedValues.get(ownerKey) as T) : initialValue

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (nextValue) => {
      setOwnedValues((previous) => {
        const nextValues = new Map(previous)
        const previousValue = nextValues.has(ownerKey)
          ? (nextValues.get(ownerKey) as T)
          : ownerInitialValue
        const resolvedValue =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(previousValue)
            : nextValue

        // Refresh insertion order so genuinely inactive generations are evicted first.
        nextValues.delete(ownerKey)
        nextValues.set(ownerKey, resolvedValue)

        while (nextValues.size > VIEWER_STATE_SLOT_LIMIT) {
          let evicted = false
          for (const candidate of nextValues.keys()) {
            if (candidate !== currentOwnerKeyRef.current) {
              nextValues.delete(candidate)
              evicted = true
              break
            }
          }
          if (!evicted) break
        }

        return nextValues
      })
    },
    [ownerInitialValue, ownerKey]
  )

  return [value, setValue] as const
}
