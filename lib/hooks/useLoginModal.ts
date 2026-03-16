'use client'

/**
 * useLoginModal — global login modal state.
 *
 * Any component can call `openLoginModal()` to show the login modal
 * without navigating to /login. The modal is rendered once in Providers.
 */

import { create } from 'zustand'

interface LoginModalState {
  isOpen: boolean
  message: string | undefined
  openLoginModal: (message?: string) => void
  closeLoginModal: () => void
}

export const useLoginModal = create<LoginModalState>((set) => ({
  isOpen: false,
  message: undefined,
  openLoginModal: (message?: string) => set({ isOpen: true, message }),
  closeLoginModal: () => set({ isOpen: false, message: undefined }),
}))
