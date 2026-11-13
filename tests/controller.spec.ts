// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import { ActivityController } from '../packages/activity/src/client/controller.ts'
import { createActivityView } from '../packages/activity/src/client/state.ts'
import type { ActivityFrame } from '../packages/activity/src/types.ts'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding, SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'

class Feed {
  private queued: ActivityFrame[] = []
  private wake?: () => void
  private closed = false
  get active() { return !this.closed }
  push(frame: ActivityFrame) { this.queued.push(frame); this.wake?.() }
  async dispose() { this.closed = true; this.wake?.() }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const value = this.queued.shift()
      if (value) yield { generation: 1, value, accept() {} }
      else await new Promise<void>(resolve => { this.wake = resolve; if (this.closed || this.queued.length) resolve() })
    }
  }
}
const a = 'a' as SessionId
const frame = (seq = 10, preview = 'current', reset = true): ActivityFrame => ({
  reset, revision: seq, read: { version: 1, installedAt: 0, revision: 0, through: {} }, hydrateBatchSize: 50, failures: [], previews: [{ sessionId: a, text: '' }],
  entries: [{ sessionId: a, summary: { seq, preview, activityAt: 200, terminalAt: 200, terminalSeq: seq, engaged: true, outcome: 'completed' } }],
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); document.body.replaceChildren(); vi.restoreAllMocks() })

function observed<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>(), previous = new Set<() => void>()
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener); previous.add(listener)
    return () => { listeners.delete(listener) }
  })
  return {
    getSnapshot: () => value, subscribe,
    set: (next: T) => { value = next; for (const listener of [...listeners]) listener() },
    activeListeners: () => listeners.size,
    notifyPrevious: () => { for (const listener of previous) listener() },
  }
}

function chatSnapshot(...ends: number[]): ChatSnapshot {
  // The consumer reads the published timeline, never raw events or a Host-added receipt field.
  const unused = (): never => { throw new Error('Activity receipt only needs the published turn timeline') }
  return {
    order: [], nodes: { get: unused, source: unused, bottomSource: unused, turnDataSource: unused, processSource: unused, values: unused },
    locations: { getTurn: unused, getStep: unused }, navigation: { items: unused },
    legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
    timeline: { turnOrder: ends.map((_, index) => index), turns: new Map(ends.map((seq, turn) => [turn, {
      turn, status: 'closed', start: undefined, steps: [], data: { get: unused, source: unused },
      end: { type: 'turn/end', seq: seq as SessionSeq, time: 200, data: { turn, reason: { kind: 'completed' } } },
    }])) },
  }
}

function generation(id = a, options: { open?: boolean; activate?: () => ChatSnapshot | undefined; afterSubscribe?: () => void } = {}) {
  const session = observed<Pick<SessionSnapshot, 'openState'>>({ openState: options.open ? 'open' : 'loading' })
  const published = observed<ChatSnapshot | undefined>(undefined)
  const chat = {
    ...published,
    subscribe: vi.fn((listener: () => void) => {
      const release = published.subscribe(listener)
      if (options.activate) published.set(options.activate())
      options.afterSubscribe?.()
      return release
    }),
  }
  const binding: SessionBinding = { sessionId: id, session: session as never, ctx: {} as SessionBinding['ctx'], eventSource: {
    getSnapshot: () => { throw new Error('Activity must read the published Chat target, not raw events') },
    subscribe: () => { throw new Error('Activity must not subscribe to raw Session events') },
  } }
  return { binding, session, chat }
}

async function bench(hydrate = vi.fn(async () => ({ ok: true, value: frame(10, 'current', false) }))) {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const ctx = new Context(), feeds: Feed[] = []
  const list = createSnapshotStore<SessionListState>({ ids: [a], byId: { [a]: { id: a, displayTitle: 'Conversation', blank: false, running: false, updatedAt: 200, retainedBy: { mainView: 1 } } }, phase: 'ready', projectionsBySession: {} }, { flush: 'sync' })
  const original = generation()
  const bindings = new Map<SessionId, ReturnType<typeof generation>>([[a, original]])
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({ phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [], pinnedSessionIds: [] }, { flush: 'sync' })
  const panelInfo = createSnapshotStore({ activePanelId: null as string | null }, { flush: 'sync' })
  const view = createActivityView(null)
  const markRead = vi.fn(async () => ({ ok: true, value: { ok: true } }))
  let carrierFailed = () => {}
  ctx.provide('sessions', { list, binding: (id: SessionId) => bindings.get(id)?.binding } as never)
  ctx.provide('uiConversation', { binding: (owner: SessionBinding) => {
    const current = bindings.get(owner.sessionId)
    if (current?.binding !== owner) throw new Error('Inactive fixture Session binding')
    return { target: (name: string): ObservableSnapshot<ChatSnapshot | undefined> => {
      expect(name).toBe('chat'); return current.chat
    } }
  } } as never)
  ctx.provide('workspaces', { list: workspaces } as never)
  ctx.provide('locale', { subscribe: () => () => {}, resolveText: (text: string | { en: string }) => typeof text === 'string' ? text : text.en } as never)
  ctx.provide('uiSession', { sessionStatus: createSnapshotStore(new Map()) } as never)
  ctx.provide('layout', { panelInfo } as never)
  ctx.provide('remote', { betterActivity: { hydrate, markRead }, $stream: (options: { carrierFailed(): void }) => {
    carrierFailed = options.carrierFailed
    const feed = new Feed(); feeds.push(feed); return feed
  } } as never)
  let controller!: ActivityController
  const fiber = ctx.plugin({ inject: ['sessions', 'workspaces', 'uiSession', 'uiConversation', 'remote', 'layout', 'locale'], apply(scope) { controller = new ActivityController(scope, view) } })
  await fiber.await(); cleanups.push(() => ctx.fiber.dispose())
  return { controller, feeds, hydrate, markRead, original, list, workspaces, bindings, view, panelInfo, visibility, focus,
    dispose: () => ctx.fiber.dispose(), disconnect: () => carrierFailed(), replaceSession: (next = generation()) => {
    bindings.set(next.binding.sessionId, next); list.set({ ...list.getSnapshot() }); return next
  } }
}

it('discards a late hydration response from the previous connection baseline', async () => {
  const pending = Promise.withResolvers<{ ok: boolean; value: ActivityFrame }>()
  const hydrate = vi.fn(async () => ({ ok: true, value: frame(20, 'new generation', false) }))
  hydrate.mockImplementationOnce(() => pending.promise)
  const h = await bench(hydrate)
  h.feeds[0]!.push(frame())
  await waitFor(() => expect(hydrate).toHaveBeenCalledOnce())
  h.feeds[0]!.push(frame(20, 'new generation'))
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('new generation'))
  pending.resolve({ ok: true, value: { ...frame(10, 'stale response', false), revision: 999 } })
  await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2))
  expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('new generation')
})

it('rebinds the same selected identity after its Session generation is replaced', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.unread).toBe(true))
  const replacement = h.replaceSession()
  await waitFor(() => expect(h.controller.data.getSnapshot().rows).toHaveLength(1))
  h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(10)); h.original.chat.notifyPrevious()
  expect(h.markRead).not.toHaveBeenCalled()
  expect(h.original.session.activeListeners()).toBe(0)
  expect(h.original.chat.activeListeners()).toBe(0)
  replacement.session.set({ openState: 'open' }); replacement.chat.set(chatSnapshot(10))
  await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 10 }]))
})

it('keeps rows during an outage and starts a fresh stream on explicit retry', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().rows).toHaveLength(1))
  h.disconnect()
  expect(h.controller.data.getSnapshot()).toMatchObject({ phase: 'offline', rows: [expect.objectContaining({ title: 'Conversation' })] })
  await h.controller.refresh()
  expect(h.feeds).toHaveLength(2)
  h.feeds[1]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
})

it('does not acquire new Session observers while its plugin is unloading', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().rows).toHaveLength(1))
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const originalDispose = h.feeds[0]!.dispose.bind(h.feeds[0])
  vi.spyOn(h.feeds[0]!, 'dispose').mockImplementation(async () => { started.resolve(); await release.promise; await originalDispose() })
  const disposing = h.dispose(); await started.promise
  const notified = Promise.withResolvers<void>()
  const off = h.list.subscribe(() => notified.resolve())
  const replacement = h.replaceSession()
  await notified.promise
  expect(replacement.session.subscribe).not.toHaveBeenCalled()
  expect(replacement.chat.subscribe).not.toHaveBeenCalled()
  off(); release.resolve(); await disposing
})

it('merges a late live delta after another conversation has hydrated at a newer revision', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.hydrate).toHaveBeenCalledOnce())
  const b = 'b' as SessionId
  h.hydrate.mockResolvedValueOnce({ ok: true, value: { ...frame(30, 'other conversation', false),
    entries: [{ sessionId: b, summary: frame(30).entries[0]!.summary }], previews: [{ sessionId: b, text: '' }] } })
  const current = h.list.getSnapshot()
  h.list.set({ ...current, ids: [a, b], byId: { ...current.byId, [b]: { id: b, displayTitle: 'Other', blank: false, running: false, updatedAt: 200, retainedBy: {} } } })
  await waitFor(() => expect(h.hydrate).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(h.controller.data.getSnapshot().rows).toHaveLength(2))
  h.feeds[0]!.push({ ...frame(20, '', false), entries: [], previews: [{ sessionId: a, text: 'LIVE PROGRESS' }] })
  await waitFor(() => expect(h.controller.data.getSnapshot().rows.find(row => row.id === a)?.preview).toBe('LIVE PROGRESS'))
})

it('keeps each newer row and read ledger when an older hydration arrives', async () => {
  const pending = Promise.withResolvers<{ ok: boolean; value: ActivityFrame }>()
  const h = await bench(vi.fn(() => pending.promise)); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.hydrate).toHaveBeenCalledOnce())
  h.feeds[0]!.push({ ...frame(20, 'new result', false), read: { ...frame().read, revision: 2, through: { a: 20 } } })
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]).toMatchObject({ preview: 'new result', unread: false }))
  pending.resolve({ ok: true, value: frame(10, 'old result', false) })
  await waitFor(() => expect(h.controller.data.getSnapshot().moreLoading).toBe(false))
  expect(h.controller.data.getSnapshot().rows[0]).toMatchObject({ preview: 'new result', unread: false })
})

it('waits for the opened body to publish its terminal event before acknowledging it', async () => {
  const h = await bench()
  h.original.session.set({ openState: 'open' })
  h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.unread).toBe(true))
  expect(h.markRead).not.toHaveBeenCalled()
  h.original.chat.set(chatSnapshot(5))
  expect(h.markRead).not.toHaveBeenCalled()
  h.original.chat.set(chatSnapshot(10))
  await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 10 }]))
  h.feeds[0]!.push(frame(15, 'next result', false))
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('next result'))
  expect(h.markRead).toHaveBeenCalledOnce()
  h.original.chat.set(chatSnapshot(10, 15))
  await waitFor(() => expect(h.markRead).toHaveBeenLastCalledWith([{ sessionId: a, throughSeq: 15 }]))
})

it('waits for the archive baseline and never acknowledges an archived conversation', async () => {
  const h = await bench()
  h.workspaces.set({ ...h.workspaces.getSnapshot(), phase: 'pending', state: 'loading' })
  h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(10))
  h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('loading'))
  expect(h.controller.data.getSnapshot().rows).toEqual([])
  expect(h.markRead).not.toHaveBeenCalled()
  h.workspaces.set({ ...h.workspaces.getSnapshot(), state: 'error' })
  await waitFor(() => expect(h.controller.data.getSnapshot()).toMatchObject({ phase: 'error', catalogError: true, rows: [] }))
  h.workspaces.set({ ...h.workspaces.getSnapshot(), state: 'idle', phase: 'ready', archivedSessionIds: [a] })
  await waitFor(() => expect(h.controller.data.getSnapshot()).toMatchObject({ phase: 'ready', catalogError: false, rows: [] }))
  expect(h.markRead).not.toHaveBeenCalled()
})

it('retains its reliable rows and suspends acknowledgements while the archive source reconnects', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().rows).toHaveLength(1))
  h.workspaces.set({ ...h.workspaces.getSnapshot(), state: 'loading' })
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('loading'))
  h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(20))
  h.feeds[0]!.push(frame(20, 'updated result', false))
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('current'))
  expect(h.markRead).not.toHaveBeenCalled()
  h.workspaces.set({ ...h.workspaces.getSnapshot(), state: 'idle' })
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('updated result'))
  await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 20 }]))
})

it('shares overlapping retries and closes every stream when unloaded', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  await Promise.all([h.controller.refresh(), h.controller.refresh()])
  expect(h.feeds).toHaveLength(2)
  expect(h.feeds.filter(feed => feed.active)).toHaveLength(1)
  h.feeds[1]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  await h.dispose()
  expect(h.feeds.filter(feed => feed.active)).toHaveLength(0)
  expect(h.original.session.activeListeners()).toBe(0)
  expect(h.original.chat.activeListeners()).toBe(0)
})

it('waits for Session opening when the Chat baseline publishes first', async () => {
  const h = await bench()
  h.original.chat.set(chatSnapshot(10)); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  expect(h.markRead).not.toHaveBeenCalled()
  h.original.session.set({ openState: 'open' })
  await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 10 }]))
  h.original.chat.set(chatSnapshot(10)); h.original.session.set({ openState: 'open' })
  expect(h.markRead).toHaveBeenCalledOnce()
})

it('handles synchronous Chat activation after establishing the new binding identity', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  const next = generation(a, { open: true, activate: () => chatSnapshot(10) })
  h.replaceSession(next)
  await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 10 }]))
  expect(h.markRead).toHaveBeenCalledOnce()
  expect(next.session.subscribe).toHaveBeenCalledOnce()
  expect(next.chat.subscribe).toHaveBeenCalledOnce()
  expect(h.original.chat.activeListeners()).toBe(0)
})

it('releases a subscription returned after synchronous activation replaces its binding', async () => {
  const h = await bench(); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  const current = generation()
  const superseded = generation(a, {
    activate: () => chatSnapshot(10), afterSubscribe: () => { h.replaceSession(current) },
  })
  h.replaceSession(superseded)
  expect(superseded.session.activeListeners()).toBe(0)
  expect(superseded.chat.activeListeners()).toBe(0)
  expect(current.session.activeListeners()).toBe(1)
  expect(current.chat.activeListeners()).toBe(1)
  superseded.session.set({ openState: 'open' }); superseded.chat.notifyPrevious()
  expect(h.markRead).not.toHaveBeenCalled()
  current.session.set({ openState: 'open' }); current.chat.set(chatSnapshot(10))
  await waitFor(() => expect(h.markRead).toHaveBeenCalledOnce())
})

it.each(['hidden', 'unfocused', 'panel', 'activity', 'dialog', 'menu', 'fullscreen'] as const)(
  'defers acknowledgement while %s and resumes without another message', async blocked => {
    const h = await bench()
    const modal = document.createElement('div')
    if (blocked === 'hidden') h.visibility.mockReturnValue('hidden')
    if (blocked === 'unfocused') h.focus.mockReturnValue(false)
    if (blocked === 'panel') h.panelInfo.set({ activePanelId: 'plugins' })
    if (blocked === 'activity') h.view.actions.toggle()
    if (blocked === 'activity' || blocked === 'dialog' || blocked === 'menu') {
      modal.setAttribute('role', blocked === 'menu' ? 'menu' : 'dialog')
      if (blocked !== 'menu') modal.setAttribute('aria-modal', 'true')
      document.body.append(modal)
    }
    if (blocked === 'fullscreen') {
      modal.dataset.sidebarRightPanel = 'fullscreen'; modal.dataset.sidebarRightOpen = 'true'; document.body.append(modal)
    }
    h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(10)); h.feeds[0]!.push(frame())
    await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
    expect(h.markRead).not.toHaveBeenCalled()
    if (blocked === 'hidden') { h.visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) }
    if (blocked === 'unfocused') { h.focus.mockReturnValue(true); window.dispatchEvent(new Event('focus')) }
    if (blocked === 'panel') h.panelInfo.set({ activePanelId: null })
    if (blocked === 'activity') {
      h.view.actions.close()
      expect(h.markRead).not.toHaveBeenCalled() // The native modal can remain mounted until React commits closure.
    }
    if (blocked === 'fullscreen') modal.removeAttribute('data-sidebar-right-open')
    else modal.remove()
    await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 10 }]))
    expect(h.markRead).toHaveBeenCalledOnce()
  },
)

it.each(['dialog', 'fullscreen'] as const)('ignores retained hidden %s and rechecks when an ancestor becomes inert', async kind => {
  const h = await bench()
  const wrapper = document.createElement('div'), dialog = document.createElement('div')
  if (kind === 'dialog') { dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true') }
  else { dialog.dataset.sidebarRightPanel = 'fullscreen'; dialog.dataset.sidebarRightOpen = 'true' }
  wrapper.hidden = true; wrapper.append(dialog); document.body.append(wrapper)
  h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(10)); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.markRead).toHaveBeenCalledOnce())
  wrapper.hidden = false
  h.original.chat.set(chatSnapshot(10, 15)); h.feeds[0]!.push(frame(15, 'next result', false))
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('next result'))
  expect(h.markRead).toHaveBeenCalledOnce()
  wrapper.setAttribute('inert', '')
  await waitFor(() => expect(h.markRead).toHaveBeenLastCalledWith([{ sessionId: a, throughSeq: 15 }]))
})

it.each(['commit', 'cancel'] as const)('does not acknowledge a tentative main-view reference before navigation %s', async outcome => {
  const h = await bench(), b = 'b' as SessionId
  const opening = { ...frame(), read: { ...frame().read, revision: 1, through: { a: 10 } } }
  h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(10)); h.feeds[0]!.push(opening)
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  const target = generation(b, { open: true, activate: () => chatSnapshot(20) })
  h.bindings.set(b, target)
  const before = h.list.getSnapshot()
  const old = before.byId[a]!
  const tentative = { id: b, displayTitle: 'Other', blank: false, running: false, updatedAt: 200, retainedBy: { mainView: 1 } }
  h.list.set({ ...before, ids: [b, a], byId: { [b]: tentative, [a]: old } })
  h.feeds[0]!.push({ ...frame(20, 'new selection', false), entries: [{ sessionId: b, summary: frame(20, 'new selection').entries[0]!.summary }], previews: [{ sessionId: b, text: '' }] })
  await waitFor(() => expect(h.controller.data.getSnapshot().rows).toHaveLength(2))
  expect(h.markRead).not.toHaveBeenCalled()
  expect(target.chat.subscribe).not.toHaveBeenCalled()
  h.list.set({ ...before, ids: [b, a], byId: {
    [b]: { ...tentative, retainedBy: outcome === 'commit' ? { mainView: 1 } : {} },
    [a]: { ...old, retainedBy: outcome === 'commit' ? {} : { mainView: 1 } },
  } })
  if (outcome === 'commit') {
    await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: b, throughSeq: 20 }]))
  } else {
    target.chat.set(chatSnapshot(20)); h.original.chat.set(chatSnapshot(10))
    expect(h.markRead).not.toHaveBeenCalled()
    expect(target.chat.subscribe).not.toHaveBeenCalled()
  }
})

it('requires the target terminal to remain in the published Chat window after replacement', async () => {
  const h = await bench(); h.view.actions.toggle()
  h.original.session.set({ openState: 'open' }); h.original.chat.set(chatSnapshot(10)); h.feeds[0]!.push(frame())
  await waitFor(() => expect(h.controller.data.getSnapshot().phase).toBe('ready'))
  h.original.chat.set(chatSnapshot(5)); h.view.actions.close()
  expect(h.markRead).not.toHaveBeenCalled()
  h.feeds[0]!.push(frame(15, 'next result', false))
  await waitFor(() => expect(h.controller.data.getSnapshot().rows[0]?.preview).toBe('next result'))
  h.original.chat.set(chatSnapshot(10))
  expect(h.markRead).not.toHaveBeenCalled()
  h.original.chat.set(chatSnapshot(15))
  await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: a, throughSeq: 15 }]))
  expect(h.markRead).toHaveBeenCalledOnce()
})
