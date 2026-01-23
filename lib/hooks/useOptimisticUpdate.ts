'use client'

/**
 * 乐观更新 Hook
 * 提供即时 UI 反馈，失败时自动回滚
 */

import { useState, useCallback, useRef } from 'react'

// ============================================
// 类型定义
// ============================================

interface OptimisticState<T> {
  /** 当前数据 */
  data: T
  /** 是否正在更新 */
  isPending: boolean
  /** 错误信息 */
  error: string | null
  /** 是否已回滚 */
  isRolledBack: boolean
}

interface OptimisticUpdateOptions<T, R = unknown> {
  /** 初始数据 */
  initialData: T
  /** 乐观更新函数（同步，立即更新 UI） */
  optimisticUpdate: (current: T) => T
  /** 实际更新函数（异步，调用 API） */
  mutationFn: () => Promise<R>
  /** 成功后的数据转换（可选） */
  onSuccess?: (result: R, current: T) => T
  /** 失败回调 */
  onError?: (error: Error, rolledBackData: T) => void
  /** 回滚延迟（毫秒，用于显示错误提示） */
  rollbackDelay?: number
}

interface UseOptimisticUpdateReturn<T> {
  /** 当前状态 */
  state: OptimisticState<T>
  /** 执行乐观更新 */
  mutate: () => Promise<void>
  /** 手动设置数据 */
  setData: (data: T | ((prev: T) => T)) => void
  /** 重置状态 */
  reset: () => void
}

// ============================================
// 主 Hook
// ============================================

/**
 * 乐观更新 Hook
 * 
 * @example
 * ```tsx
 * const { state, mutate } = useOptimisticUpdate({
 *   initialData: post,
 *   optimisticUpdate: (post) => ({
 *     ...post,
 *     like_count: post.like_count + 1,
 *     is_liked: true,
 *   }),
 *   mutationFn: () => likePost(post.id),
 *   onError: (error) => toast.error('点赞失败'),
 * })
 * 
 * return (
 *   <button onClick={mutate} disabled={state.isPending}>
 *     {state.data.is_liked ? '已点赞' : '点赞'} ({state.data.like_count})
 *   </button>
 * )
 * ```
 */
export function useOptimisticUpdate<T, R = unknown>(
  options: OptimisticUpdateOptions<T, R>
): UseOptimisticUpdateReturn<T> {
  const {
    initialData,
    optimisticUpdate,
    mutationFn,
    onSuccess,
    onError,
    rollbackDelay = 0,
  } = options

  const [state, setState] = useState<OptimisticState<T>>({
    data: initialData,
    isPending: false,
    error: null,
    isRolledBack: false,
  })

  const previousDataRef = useRef<T>(initialData)
  // 使用 ref 跟踪当前数据以避免 stale closure
  const currentDataRef = useRef<T>(state.data)
  currentDataRef.current = state.data

  const mutate = useCallback(async () => {
    // 从 ref 获取最新数据以避免 stale closure
    const currentData = currentDataRef.current

    // 保存当前数据用于回滚
    previousDataRef.current = currentData

    // 乐观更新
    const optimisticData = optimisticUpdate(currentData)
    setState({
      data: optimisticData,
      isPending: true,
      error: null,
      isRolledBack: false,
    })

    try {
      // 执行实际更新
      const result = await mutationFn()

      // 成功：使用服务器返回的数据或保持乐观数据
      const finalData = onSuccess ? onSuccess(result, optimisticData) : optimisticData
      setState({
        data: finalData,
        isPending: false,
        error: null,
        isRolledBack: false,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '操作失败'

      // 设置错误状态
      setState((prev) => ({
        ...prev,
        isPending: false,
        error: errorMessage,
        isRolledBack: false,
      }))

      // 延迟回滚（给用户时间看到错误）
      if (rollbackDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, rollbackDelay))
      }

      // 回滚到之前的数据
      setState({
        data: previousDataRef.current,
        isPending: false,
        error: errorMessage,
        isRolledBack: true,
      })

      // 调用错误回调
      onError?.(error instanceof Error ? error : new Error(errorMessage), previousDataRef.current)
    }
  }, [optimisticUpdate, mutationFn, onSuccess, onError, rollbackDelay])

  const setData = useCallback((updater: T | ((prev: T) => T)) => {
    setState((prev) => ({
      ...prev,
      data: typeof updater === 'function' ? (updater as (prev: T) => T)(prev.data) : updater,
    }))
  }, [])

  const reset = useCallback(() => {
    setState({
      data: initialData,
      isPending: false,
      error: null,
      isRolledBack: false,
    })
    previousDataRef.current = initialData
  }, [initialData])

  return {
    state,
    mutate,
    setData,
    reset,
  }
}

// ============================================
// 专用 Hooks
// ============================================

interface LikeState {
  isLiked: boolean
  likeCount: number
}

/**
 * 点赞乐观更新 Hook
 */
export function useOptimisticLike(
  initialState: LikeState,
  likeFn: () => Promise<void>,
  unlikeFn: () => Promise<void>,
  onError?: (error: Error) => void
) {
  const [state, setState] = useState<LikeState & { isPending: boolean; error: string | null }>({
    ...initialState,
    isPending: false,
    error: null,
  })

  const previousStateRef = useRef(initialState)
  // 使用 ref 跟踪当前状态以避免 stale closure
  const currentStateRef = useRef(state)
  currentStateRef.current = state

  const toggle = useCallback(async () => {
    const current = currentStateRef.current
    const willLike = !current.isLiked
    previousStateRef.current = { isLiked: current.isLiked, likeCount: current.likeCount }

    // 乐观更新
    setState({
      isLiked: willLike,
      likeCount: current.likeCount + (willLike ? 1 : -1),
      isPending: true,
      error: null,
    })

    try {
      await (willLike ? likeFn() : unlikeFn())
      setState((prev) => ({ ...prev, isPending: false }))
    } catch (error) {
      // 回滚
      setState({
        ...previousStateRef.current,
        isPending: false,
        error: error instanceof Error ? error.message : '操作失败',
      })
      onError?.(error instanceof Error ? error : new Error('操作失败'))
    }
  }, [likeFn, unlikeFn, onError])

  return {
    isLiked: state.isLiked,
    likeCount: state.likeCount,
    isPending: state.isPending,
    error: state.error,
    toggle,
  }
}

interface BookmarkState {
  isBookmarked: boolean
}

/**
 * 收藏乐观更新 Hook
 */
export function useOptimisticBookmark(
  initialState: BookmarkState,
  addBookmarkFn: () => Promise<void>,
  removeBookmarkFn: () => Promise<void>,
  onError?: (error: Error) => void
) {
  const [state, setState] = useState<BookmarkState & { isPending: boolean; error: string | null }>({
    ...initialState,
    isPending: false,
    error: null,
  })

  const previousStateRef = useRef(initialState)
  // 使用 ref 跟踪当前状态以避免 stale closure
  const currentStateRef = useRef(state)
  currentStateRef.current = state

  const toggle = useCallback(async () => {
    const current = currentStateRef.current
    const willBookmark = !current.isBookmarked
    previousStateRef.current = { isBookmarked: current.isBookmarked }

    // 乐观更新
    setState({
      isBookmarked: willBookmark,
      isPending: true,
      error: null,
    })

    try {
      await (willBookmark ? addBookmarkFn() : removeBookmarkFn())
      setState((prev) => ({ ...prev, isPending: false }))
    } catch (error) {
      // 回滚
      setState({
        ...previousStateRef.current,
        isPending: false,
        error: error instanceof Error ? error.message : '操作失败',
      })
      onError?.(error instanceof Error ? error : new Error('操作失败'))
    }
  }, [addBookmarkFn, removeBookmarkFn, onError])

  return {
    isBookmarked: state.isBookmarked,
    isPending: state.isPending,
    error: state.error,
    toggle,
  }
}

interface FollowState {
  isFollowing: boolean
  followerCount: number
}

/**
 * 关注乐观更新 Hook
 */
export function useOptimisticFollow(
  initialState: FollowState,
  followFn: () => Promise<void>,
  unfollowFn: () => Promise<void>,
  onError?: (error: Error) => void
) {
  const [state, setState] = useState<FollowState & { isPending: boolean; error: string | null }>({
    ...initialState,
    isPending: false,
    error: null,
  })

  const previousStateRef = useRef(initialState)
  // 使用 ref 跟踪当前状态以避免 stale closure
  const currentStateRef = useRef(state)
  currentStateRef.current = state

  const toggle = useCallback(async () => {
    const current = currentStateRef.current
    const willFollow = !current.isFollowing
    previousStateRef.current = { isFollowing: current.isFollowing, followerCount: current.followerCount }

    // 乐观更新
    setState({
      isFollowing: willFollow,
      followerCount: current.followerCount + (willFollow ? 1 : -1),
      isPending: true,
      error: null,
    })

    try {
      await (willFollow ? followFn() : unfollowFn())
      setState((prev) => ({ ...prev, isPending: false }))
    } catch (error) {
      // 回滚
      setState({
        ...previousStateRef.current,
        isPending: false,
        error: error instanceof Error ? error.message : '操作失败',
      })
      onError?.(error instanceof Error ? error : new Error('操作失败'))
    }
  }, [followFn, unfollowFn, onError])

  return {
    isFollowing: state.isFollowing,
    followerCount: state.followerCount,
    isPending: state.isPending,
    error: state.error,
    toggle,
  }
}

// ============================================
// 列表乐观更新 Hook
// ============================================

interface UseOptimisticListOptions<T> {
  /** 初始列表 */
  initialData: T[]
  /** 获取项目 ID */
  getId: (item: T) => string
}

/**
 * 列表乐观更新 Hook
 * 支持添加、更新、删除操作
 */
export function useOptimisticList<T>(options: UseOptimisticListOptions<T>) {
  const { initialData, getId } = options

  const [items, setItems] = useState<T[]>(initialData)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const previousItemsRef = useRef<Map<string, T>>(new Map())

  /**
   * 乐观添加项目
   */
  const optimisticAdd = useCallback(
    async (item: T, addFn: () => Promise<T | void>) => {
      const id = getId(item)

      // 乐观添加
      setItems((prev) => [item, ...prev])
      setPendingIds((prev) => new Set(prev).add(id))

      try {
        const result = await addFn()
        // 如果服务器返回了新数据，使用它
        if (result) {
          const _newId = getId(result)
          setItems((prev) =>
            prev.map((i) => (getId(i) === id ? result : i))
          )
          setPendingIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        } else {
          setPendingIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        }
      } catch (error) {
        // 回滚：移除项目
        setItems((prev) => prev.filter((i) => getId(i) !== id))
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        throw error
      }
    },
    [getId]
  )

  /**
   * 乐观更新项目
   */
  const optimisticUpdate = useCallback(
    async (id: string, updater: (item: T) => T, updateFn: () => Promise<T | void>) => {
      // 保存原始数据
      const original = items.find((i) => getId(i) === id)
      if (original) {
        previousItemsRef.current.set(id, original)
      }

      // 乐观更新
      setItems((prev) => prev.map((i) => (getId(i) === id ? updater(i) : i)))
      setPendingIds((prev) => new Set(prev).add(id))

      try {
        const result = await updateFn()
        if (result) {
          setItems((prev) => prev.map((i) => (getId(i) === id ? result : i)))
        }
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        previousItemsRef.current.delete(id)
      } catch (error) {
        // 回滚
        const original = previousItemsRef.current.get(id)
        if (original) {
          setItems((prev) => prev.map((i) => (getId(i) === id ? original : i)))
        }
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        previousItemsRef.current.delete(id)
        throw error
      }
    },
    [items, getId]
  )

  /**
   * 乐观删除项目
   */
  const optimisticRemove = useCallback(
    async (id: string, removeFn: () => Promise<void>) => {
      // 保存原始数据
      const original = items.find((i) => getId(i) === id)
      const originalIndex = items.findIndex((i) => getId(i) === id)
      if (original) {
        previousItemsRef.current.set(id, original)
      }

      // 乐观删除
      setItems((prev) => prev.filter((i) => getId(i) !== id))
      setPendingIds((prev) => new Set(prev).add(id))

      try {
        await removeFn()
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        previousItemsRef.current.delete(id)
      } catch (error) {
        // 回滚：恢复项目
        const original = previousItemsRef.current.get(id)
        if (original) {
          setItems((prev) => {
            const next = [...prev]
            next.splice(originalIndex, 0, original)
            return next
          })
        }
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        previousItemsRef.current.delete(id)
        throw error
      }
    },
    [items, getId]
  )

  return {
    items,
    setItems,
    pendingIds,
    isPending: (id: string) => pendingIds.has(id),
    optimisticAdd,
    optimisticUpdate,
    optimisticRemove,
  }
}

// ============================================
// 导出类型
// ============================================

export type {
  OptimisticState,
  OptimisticUpdateOptions,
  UseOptimisticUpdateReturn,
  LikeState,
  BookmarkState,
  FollowState,
  UseOptimisticListOptions,
}
