/** One Client generation's activity stream, hydration queue and read acknowledgements. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from 'dsh-better-activity/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { modalSelector } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActivityFrame, ActivityReadState, ActivitySummary, ReadAcknowledgement } from '../types.ts'
import { deriveRows, type ActivityData } from './model.ts'
import type { ActivityView } from './state.ts'

const blockingLayers = `${modalSelector}, [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]`
const layerAttributes = ['role', 'aria-modal', 'hidden', 'inert', 'aria-hidden', 'data-sidebar-right-panel', 'data-sidebar-right-open']

export class ActivityController {
  readonly data = createSnapshotStore<ActivityData>({ phase: 'loading', rows: [], moreLoading: false, mutationError: false, summaryError: false, catalogError: false })
  private readonly summaries = new Map<SessionId, ActivitySummary>()
  private readonly previews = new Map<SessionId, string>()
  private read: ActivityReadState | null = null
  private readonly revisions = new Map<SessionId, number>()
  private streamPhase: ActivityData['phase'] = 'loading'
  private epoch = 0
  private batchSize = 50
  private readonly failures = new Set<SessionId>()
  private readonly hydrated = new Set<SessionId>()
  private hydrating = false
  private readonly cancel = new AbortController()
  private following!: { stream: RemoteStream<ActivityFrame>; consuming: Promise<void> }
  private refreshing?: Promise<void>
  private current?: SessionId
  private currentBinding?: SessionBinding
  private currentChat?: ObservableSnapshot<ChatSnapshot | undefined>
  private releaseCurrent?: () => void
  private readonly acknowledgements = new Set<string>()
  private disposed = false

  /** @param ctx - Plugin-owned Client services. @param view - This window's activity visibility. */
  constructor(private readonly ctx: Context, private readonly view: ActivityView) {
    this.startFollowing()
    const refresh = (): void => { if (this.disposed) return; this.bindCurrent(); this.rebuild(); void this.hydrate() }
    ctx.effect(() => ctx.sessions.list.subscribe(refresh), 'better-activity: catalog')
    ctx.effect(() => ctx.workspaces.list.subscribe(refresh), 'better-activity: projects')
    ctx.effect(() => ctx.uiSession.sessionStatus.subscribe(() => this.rebuild()), 'better-activity: status')
    ctx.effect(() => ctx.locale.subscribe(() => this.rebuild()), 'better-activity: language')
    ctx.effect(() => ctx.layout.panelInfo.subscribe(() => this.acknowledgeCurrent()), 'better-activity: visible panel')
    ctx.effect(() => view.state.subscribe(() => this.acknowledgeCurrent()), 'better-activity: overlay visibility')
    const visible = (): void => { this.acknowledgeCurrent() }
    document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible)
    const containsModal = (node: Node): boolean => node instanceof Element && (node.matches(blockingLayers) || node.querySelector(blockingLayers) !== null)
    const overlays = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes'
        ? containsModal(record.target) || ['role', 'aria-modal', 'data-sidebar-right-panel', 'data-sidebar-right-open'].includes(record.attributeName ?? '')
        : [...record.addedNodes, ...record.removedNodes].some(containsModal))) this.acknowledgeCurrent()
    })
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: layerAttributes })
    ctx.effect(() => async () => {
      this.disposed = true; this.cancel.abort(); this.releaseCurrent?.()
      overlays.disconnect()
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible)
      await this.following.stream.dispose(); await this.following.consuming
      await this.refreshing
    }, 'better-activity: client lifetime')
    refresh()
  }

  private startFollowing(): void {
    const stream = this.ctx.remote.$stream<ActivityFrame>({
      name: 'BetterActivity', open: signal => this.ctx.remote.betterActivity.follow(signal), ended: () => new Error('Activity stream ended'),
      carrierFailed: () => { if (!this.disposed && this.following.stream === stream) { this.streamPhase = 'offline'; this.rebuild() } },
    })
    const consuming = (async () => {
      try {
        for await (const frame of stream) {
          if (this.disposed || this.following.stream !== stream) break
          if (frame.value.reset) { this.epoch++; this.hydrated.clear(); this.acknowledgements.clear() }
          this.streamPhase = 'ready'
          this.accept(frame.value); frame.accept(); void this.hydrate()
        }
      } catch (error) {
        if (this.disposed || this.following.stream !== stream) return
        this.streamPhase = 'error'; this.rebuild(); console.error('BetterActivity stream failed', error)
      }
    })()
    this.following = { stream, consuming }
  }
  private accept(frame: ActivityFrame): void {
    if (this.disposed) return
    this.batchSize = frame.hydrateBatchSize
    if (frame.reset) { this.revisions.clear(); this.summaries.clear(); this.previews.clear(); this.failures.clear() }
    if (frame.reset || this.read === null || frame.read.revision > this.read.revision) this.read = frame.read
    // Hydration and follow arrive independently; a newer row cannot supersede another row's delta.
    const accepted = new Set([...frame.entries.map(item => item.sessionId), ...frame.previews.map(item => item.sessionId), ...frame.failures]
      .filter(id => frame.revision >= (this.revisions.get(id) ?? -1)))
    for (const id of accepted) { this.revisions.set(id, frame.revision); this.failures.delete(id) }
    for (const item of frame.entries) if (accepted.has(item.sessionId)) this.summaries.set(item.sessionId, item.summary)
    for (const item of frame.previews) if (accepted.has(item.sessionId)) {
      if (item.text) this.previews.set(item.sessionId, item.text); else this.previews.delete(item.sessionId)
    }
    for (const id of frame.failures) if (accepted.has(id)) this.failures.add(id)
    this.rebuild()
  }
  private rebuild(): void {
    if (this.disposed) return
    const list = this.ctx.sessions.list.getSnapshot(), workspaces = this.ctx.workspaces.list.getSnapshot()
    const catalogError = workspaces.state === 'error'
    const catalogReady = list.phase === 'ready' && workspaces.phase === 'ready' && workspaces.state === 'idle'
    const phase = this.streamPhase === 'ready' ? catalogError ? 'error' : catalogReady ? 'ready' : 'loading' : this.streamPhase
    this.data.update(value => {
      value.phase = phase; value.catalogError = catalogError
      if (phase === 'ready') {
        value.rows = deriveRows(list, workspaces, this.ctx.uiSession.sessionStatus.getSnapshot(), this.summaries, this.previews, this.read, this.failures,
          reason => this.ctx.locale.resolveText(reason))
        value.summaryError = value.rows.some(row => this.failures.has(row.id) || this.failures.has(row.target))
      }
    })
    this.acknowledgeCurrent()
  }
  private bindCurrent(): void {
    if (this.disposed) return
    const list = this.ctx.sessions.list.getSnapshot()
    const selected = Object.values(list.byId).filter(item => (item.retainedBy.mainView ?? 0) > 0)
    const id = selected.length === 1 ? selected[0]!.id : undefined
    const binding = id ? this.ctx.sessions.binding(id) : undefined
    if (id === this.current && binding === this.currentBinding) return
    this.releaseCurrent?.(); this.releaseCurrent = undefined
    this.current = id; this.currentBinding = binding; this.currentChat = undefined
    if (binding) {
      const chat = this.ctx.uiConversation.binding(binding).target('chat')
      this.currentChat = chat
      const disposers: (() => void)[] = []
      const release = (): void => { for (const dispose of disposers.splice(0)) dispose() }
      this.releaseCurrent = release
      const changed = (): void => {
        if (!this.disposed && this.currentBinding === binding && this.currentChat === chat) this.acknowledgeCurrent()
      }
      // Chat activation can publish synchronously; identity and cleanup ownership exist before subscribing.
      for (const source of [binding.session, chat]) {
        const dispose = source.subscribe(changed)
        if (this.disposed || this.currentBinding !== binding || this.currentChat !== chat) { dispose(); release(); return }
        disposers.push(dispose)
      }
    }
    this.acknowledgeCurrent()
  }
  private acknowledgeCurrent(): void {
    if (this.disposed || !this.current || this.view.state.getSnapshot().open || this.data.getSnapshot().phase !== 'ready' || this.data.getSnapshot().mutationError
      || document.visibilityState !== 'visible' || !document.hasFocus() || this.ctx.layout.panelInfo.getSnapshot().activePanelId !== null) return
    if ([...document.querySelectorAll(blockingLayers)].some(element => !element.closest('[hidden], [inert], [aria-hidden="true"]'))) return
    const binding = this.ctx.sessions.binding(this.current)
    if (!binding || binding !== this.currentBinding) return
    const selected = Object.values(this.ctx.sessions.list.getSnapshot().byId).filter(item => (item.retainedBy.mainView ?? 0) > 0)
    if (selected.length !== 1 || selected[0]!.id !== this.current) return
    const snapshot = binding.session.getSnapshot()
    if (snapshot?.openState !== 'open') return
    const target = this.data.getSnapshot().rows.flatMap(row => row.readTargets).find(item => item.sessionId === this.current)
    if (!target) return
    const chat = this.currentChat?.getSnapshot()
    if (!chat || ![...chat.timeline.turns.values()].some(turn => turn.end?.seq === target.throughSeq)) return
    const key = `${target.sessionId}:${target.throughSeq}`
    if (this.acknowledgements.has(key)) return
    this.acknowledgements.add(key)
    void this.markRead([target]).then(ok => { if (!ok) this.acknowledgements.delete(key) })
  }
  private async hydrate(): Promise<void> {
    if (this.hydrating || this.disposed || this.data.getSnapshot().phase !== 'ready') return
    this.hydrating = true; this.data.update(value => { value.moreLoading = true })
    let requestEpoch = this.epoch
    try {
      while (!this.disposed && this.data.getSnapshot().phase === 'ready') {
        const list = this.ctx.sessions.list.getSnapshot()
        const priority = this.data.getSnapshot().rows.map(row => row.target)
        const ids = [...new Set([...priority, ...list.ids])].filter(id => !this.hydrated.has(id) && !list.byId[id]?.blank).slice(0, this.batchSize)
        if (!ids.length) break
        requestEpoch = this.epoch
        const result = await this.ctx.remote.betterActivity.hydrate({ sessionIds: ids }, this.cancel.signal)
        if (this.disposed) return
        if (requestEpoch !== this.epoch) continue
        if (!result.ok) throw result.error
        for (const id of ids) this.hydrated.add(id)
        this.accept(result.value)
      }
    } catch (error) {
      if (!this.disposed && requestEpoch === this.epoch) { this.streamPhase = 'error'; this.rebuild(); console.error('Activity summaries could not be loaded', error) }
    } finally {
      this.hydrating = false
      if (!this.disposed) { this.data.update(value => { value.moreLoading = false }); if (requestEpoch !== this.epoch) void this.hydrate() }
    }
  }
  /** Retry keeps readable rows while restarting the stream and historical work. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.refreshing) return this.refreshing
    const previous = this.following
    this.epoch++; this.streamPhase = 'loading'; this.rebuild()
    const task = (async () => {
      try {
        await previous.stream.dispose(); await previous.consuming
        if (this.disposed) return
        this.data.update(value => { value.mutationError = false }); this.startFollowing()
      } catch (error) {
        if (!this.disposed) { this.streamPhase = 'error'; this.rebuild(); console.error('Activity retry failed', error) }
      }
    })().finally(() => { if (this.refreshing === task) this.refreshing = undefined })
    this.refreshing = task
    return task
  }
  /** @param items - Actually observed terminal versions. @returns Successful durable acknowledgement. */
  async markRead(items: ReadAcknowledgement[]): Promise<boolean> {
    if (!items.length) return true
    try {
      const result = await this.ctx.remote.betterActivity.markRead(items)
      if (!result.ok || !result.value.ok) throw new Error('Activity acknowledgement rejected')
      return true
    } catch (error) {
      if (!this.disposed) { this.data.update(value => { value.mutationError = true }); console.error('Activity acknowledgement failed', error) }
      return false
    }
  }
}
