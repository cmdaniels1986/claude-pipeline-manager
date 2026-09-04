import { create } from 'zustand'
import type { PreviewState } from '../../../shared/types'

interface PreviewUiStore {
  /** the active project's preview state, mirrored from the main process */
  state: PreviewState | null
  apply: (s: PreviewState) => void
}

export const usePreviewStore = create<PreviewUiStore>((set) => ({
  state: null,
  apply: (s) => set({ state: s })
}))

if (typeof window !== 'undefined' && window.api) {
  void window.api.previewGet().then((s) => usePreviewStore.getState().apply(s))
  window.api.onPreviewChanged((s) => usePreviewStore.getState().apply(s))
}
