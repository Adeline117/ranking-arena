import type { Dispatch, SetStateAction } from 'react'

export type ReplyTarget = { commentId: string; handle: string }
export type ReplyTargetSetter = Dispatch<SetStateAction<ReplyTarget | null>>
