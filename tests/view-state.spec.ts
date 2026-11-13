// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createActivityView } from '../packages/activity/src/client/state.ts'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

it('restores one window without sharing visibility with another window', () => {
  const firstWindow = storage(), secondWindow = storage()
  const first = createActivityView(firstWindow)
  first.actions.toggle(); first.actions.more(); first.actions.rememberScroll(380); first.save()
  expect(createActivityView(firstWindow).state.getSnapshot()).toEqual({ open: true, limit: 100, scrollTop: 380 })
  expect(createActivityView(secondWindow).state.getSnapshot()).toEqual({ open: false, limit: 50, scrollTop: 0 })
  first.actions.close()
  expect(createActivityView(firstWindow).state.getSnapshot()).toEqual({ open: false, limit: 100, scrollTop: 380 })
})

it('ignores invalid preferences and keeps the view usable when storage fails', () => {
  const invalid = createActivityView({ getItem: () => '{"open":"yes","limit":-2,"scrollTop":-5}', setItem: () => {} })
  expect(invalid.state.getSnapshot()).toEqual({ open: false, limit: 50, scrollTop: 0 })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const view = createActivityView({ getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    view.actions.toggle(); view.actions.rememberScroll(30); view.actions.close()
    expect(view.state.getSnapshot()).toEqual({ open: false, limit: 50, scrollTop: 30 })
    expect(warning).toHaveBeenCalled()
  } finally { warning.mockRestore() }
})
