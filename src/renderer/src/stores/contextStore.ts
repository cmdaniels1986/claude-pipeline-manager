import { create } from 'zustand'
import type { ContextPost } from '../../../shared/types'

interface ContextUiStore {
  /** the shared folder path, or null when this project isn't shared */
  sharedPath: string | null
  posts: ContextPost[]
  apply: (s: { sharedPath: string | null; posts: ContextPost[] }) => void
}

export const useContextStore = create<ContextUiStore>((set) => ({
  sharedPath: null,
  posts: [],
  apply: (s) => set({ sharedPath: s.sharedPath, posts: s.posts })
}))

if (typeof window !== 'undefined' && window.api) {
  void window.api.contextGet().then((snap) => {
    if (snap) useContextStore.getState().apply(snap)
  })
  window.api.onContextChanged((snap) => useContextStore.getState().apply(snap))
}
