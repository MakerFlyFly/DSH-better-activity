/** Window-local activity visibility and scroll restoration. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface ActivityViewState { open: boolean; limit: number; scrollTop: number }
export interface ActivityViewActions {
  toggle: () => void
  close: () => void
  more: () => void
  rememberScroll: (top: number) => void
}
const storageKey = 'better-activity.view.v1'

/** @param storage - Window session storage; null disables restoration for a caller. @returns One owned view source and its actions. */
export function createActivityView(storage?: Pick<Storage, 'getItem' | 'setItem'> | null) {
  let saved: Partial<ActivityViewState> = {}
  try {
    storage ??= storage === null ? null : window.sessionStorage
    const raw = storage?.getItem(storageKey)
    if (raw) { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object') saved = parsed }
  } catch (error) { console.warn('Activity view preference is unavailable', error) }
  const initial: ActivityViewState = {
    open: saved.open === true,
    limit: Number.isSafeInteger(saved.limit) && saved.limit! >= 50 && saved.limit! <= 100_000 ? saved.limit! : 50,
    scrollTop: typeof saved.scrollTop === 'number' && Number.isFinite(saved.scrollTop) && saved.scrollTop >= 0 ? saved.scrollTop : 0,
  }
  const state = createSnapshotStore(initial, { flush: 'sync' })
  const save = (): void => {
    try { storage?.setItem(storageKey, JSON.stringify(state.getSnapshot())) }
    catch (error) { storage = null; console.warn('Activity view preference could not be saved', error) }
  }
  const actions: ActivityViewActions = {
    toggle: () => { state.update(value => { value.open = !value.open }); save() },
    close: () => { state.update(value => { value.open = false }); save() },
    more: () => { state.update(value => { value.limit = Math.min(100_000, value.limit + 50) }); save() },
    rememberScroll: top => {
      if (Number.isFinite(top) && top >= 0) state.update(value => { value.scrollTop = top })
    },
  }
  return { state, actions, save }
}
export type ActivityView = ReturnType<typeof createActivityView>
