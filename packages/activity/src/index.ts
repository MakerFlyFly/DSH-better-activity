/** Host-owned activity projection, live previews and durable acknowledgement ledger. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { activityProjection, previewText } from './domain/projection.ts'
import type { ActivityFrame, ActivitySummary, ActivityReadState, MarkReadResult, ReadAcknowledgement, HydrationRequest } from './types.ts'
export type * from './types.ts'

/** Host budgets, resolved at activation. */
export interface Config { previewCodePoints?: number; previewIntervalMs?: number; hydrateBatchSize?: number }
const readSchema = z.object({ version: z.literal(1), installedAt: z.number(), revision: z.number().int().nonnegative(), through: z.record(z.string(), z.number().int().min(-1)) })
const domainSpec = defineDomain({ name: 'better_activity', version: 1, tables: { read: domainTable(readSchema) } })
type ActivityDomain = Domain<typeof domainSpec>

declare module '@deepseek-ai/cordis' { interface Context { betterActivity: BetterActivity } }

/** The activity plugin's durable and process-local state. */
export default class BetterActivity extends TypertRemoteService {
  static inject = ['storageDomain', 'typert', 'sessionProjections', 'sessionQuery', 'agents', 'remoteAccess']
  private domain!: ActivityDomain
  private projection!: ProjectionHandle<ActivitySummary>
  private readonly summaries = new Map<SessionId, ActivitySummary>()
  private readonly failures = new Set<SessionId>()
  private readonly live = new Map<SessionId, { attempt: string; text: string }>()
  private readonly listeners = new Set<(id: SessionId | null) => void>()
  private readonly lifetime = new AbortController()
  private hydrationTail = Promise.resolve()
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly previewIds = new Set<SessionId>()
  private readonly budget: { previewCodePoints: number; previewIntervalMs: number; hydrateBatchSize: number }

  /** @param ctx - Host services. @param config - Optional positive integral resource budgets. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'betterActivity', { namespace: 'betterActivity' })
    this.budget = { previewCodePoints: config.previewCodePoints ?? 240, previewIntervalMs: config.previewIntervalMs ?? 100, hydrateBatchSize: config.hydrateBatchSize ?? 50 }
    for (const [key, value] of Object.entries(this.budget)) if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error(`BetterActivity: ${key} must be an integer between 1 and 100000`)
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(activityProjection(this.budget.previewCodePoints))
    this.domain = await this.ctx.storageDomain.open(domainSpec)
    try {
      if (!this.domain.table('read').get('owner')) await this.domain.table('read').put('owner', { version: 1, installedAt: Date.now(), revision: 0, through: {} })
    } catch (error) { await this.domain.close(); throw error }
    this.ctx.effect(() => async () => {
      this.lifetime.abort(); clearTimeout(this.timer)
      for (const notify of this.listeners) notify(null)
      await this.hydrationTail
      await this.domain.close()
    }, 'better-activity: state lifetime')
    this.ctx.on('domain/changed', event => { if (event.domain === domainSpec.name) this.publish(null) })
    this.ctx.sessionProjections.onEventChanged((session, changes) => {
      if (changes.some(change => change.key === 'betterActivity')) this.accept(session.id, this.projection.stateOf(session))
    })
    this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const id = agent.session.id
      if (frame.type === 'start') this.live.set(id, { attempt: frame.attemptId, text: '' })
      else if (frame.type === 'chunk') {
        const current = this.live.get(id)
        if (!current || current.attempt !== frame.attemptId || frame.chunk.type !== 'text-delta') return
        const previous = previewText(current.text, this.budget.previewCodePoints)
        // Keep only the prefix needed for the two-line preview, including markdown whitespace.
        current.text = Array.from(current.text + frame.chunk.text).slice(0, this.budget.previewCodePoints * 4).join('')
        if (previewText(current.text, this.budget.previewCodePoints) === previous) return
      } else if (this.live.get(id)?.attempt === frame.attemptId) this.live.delete(id)
      // Snapshot versions change with visible state; the timer only coalesces notifications.
      this.revision++
      this.previewIds.add(id)
      this.timer ??= setTimeout(() => {
        this.timer = undefined
        for (const changed of this.previewIds) this.notify(changed)
        this.previewIds.clear()
      }, this.budget.previewIntervalMs)
    })
  }

  private accept(id: SessionId, value: ActivitySummary): void {
    const previous = this.summaries.get(id)
    if (previous !== undefined && previous.seq > value.seq) return
    const recovered = this.failures.delete(id)
    if (previous !== undefined && previous.seq === value.seq && previous.activityAt === value.activityAt
      && previous.preview === value.preview && previous.outcome === value.outcome && previous.terminalSeq === value.terminalSeq
      && previous.terminalAt === value.terminalAt && previous.engaged === value.engaged) {
      if (recovered) this.publish(id)
      return
    }
    this.summaries.set(id, value)
    this.publish(id)
  }
  private publish(id: SessionId | null): void {
    this.revision++
    this.notify(id)
  }
  private notify(id: SessionId | null): void {
    for (const listener of this.listeners) listener(id)
  }
  private allowed(id: SessionId): boolean { return this.ctx.remoteAccess.allows({ kind: 'session', id }) }
  private frame(reset: boolean, ids: readonly SessionId[]): ActivityFrame {
    const stored = this.domain.table('read').get('owner')!
    const read: ActivityReadState = { ...stored, through: Object.fromEntries(Object.entries(stored.through).filter(([id]) => this.allowed(id as SessionId))) }
    return {
      reset, revision: this.revision, read,
      hydrateBatchSize: this.budget.hydrateBatchSize,
      failures: ids.filter(id => this.failures.has(id) && this.allowed(id)),
      entries: ids.filter(id => this.allowed(id) && this.summaries.has(id)).map(sessionId => ({ sessionId, summary: this.summaries.get(sessionId)! })),
      previews: ids.filter(id => this.allowed(id)).map(sessionId => ({ sessionId, text: previewText(this.live.get(sessionId)?.text ?? '', this.budget.previewCodePoints) })),
    }
  }

  /** @returns The current authorized baseline and committed read ledger. */
  @Remote('snapshot')
  async snapshot(): Promise<ActivityFrame> { return structuredClone(this.frame(true, [...new Set([...this.summaries.keys(), ...this.live.keys(), ...this.failures])])) }

  /**
   * Prepare bounded historical summaries without activating Agents or reading logs in the Client.
   * @param request - Visible conversation identities, up to hydrateBatchSize.
   * @param signal - Cancellation of the caller's read.
   * @returns Recovered summaries; a failed read rejects without clearing cached rows.
   */
  @Remote('hydrate')
  async hydrate(request: HydrationRequest, signal: AbortSignal): Promise<ActivityFrame> {
    const ids = request.sessionIds
    if (ids.length > this.budget.hydrateBatchSize || ids.some(id => !this.allowed(id))) throw new Error('Activity hydration request is unavailable')
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const work = this.hydrationTail.then(async () => {
      for (const id of new Set(ids)) {
        combined.throwIfAborted()
        try {
          const value = await this.ctx.sessionQuery.inspectSession(id, session => structuredClone(this.projection.stateOf(session)), combined)
          combined.throwIfAborted()
          this.accept(id, value)
        } catch (error) {
          combined.throwIfAborted()
          this.failures.add(id); this.publish(id)
          this.ctx.logger.warn(`Activity summary unavailable for ${id}: ${String(error)}`)
        }
      }
    })
    // Each caller observes its rejection; the queue remains usable for later independent reads.
    this.hydrationTail = work.catch((error: unknown) => { void error })
    await work
    return this.frame(false, ids)
  }

  /**
   * Advance acknowledgements atomically, never beyond the event supplied by the viewer.
   * @param items - Observed terminal event positions.
   * @returns Whether the full acknowledgement was committed.
   */
  @Remote('markRead')
  async markRead(items: ReadAcknowledgement[]): Promise<MarkReadResult> {
    if (items.some(item => !Number.isSafeInteger(item.throughSeq) || item.throughSeq < 0)) return { ok: false, code: 'invalid-request' }
    if (items.some(item => !this.allowed(item.sessionId))) return { ok: false, code: 'unavailable' }
    for (const item of items) {
      if (item.throughSeq <= (this.summaries.get(item.sessionId)?.terminalSeq ?? -1)) continue
      try {
        const value = await this.ctx.sessionQuery.inspectSession(item.sessionId,
          session => structuredClone(this.projection.stateOf(session)), this.lifetime.signal)
        this.lifetime.signal.throwIfAborted()
        this.accept(item.sessionId, value)
      } catch (error) {
        this.lifetime.signal.throwIfAborted()
        this.ctx.logger.warn(`Activity acknowledgement could not read ${item.sessionId}: ${String(error)}`)
        return { ok: false, code: 'unavailable' }
      }
      if (item.throughSeq > (this.summaries.get(item.sessionId)?.terminalSeq ?? -1)) return { ok: false, code: 'unavailable' }
    }
    await this.domain.table('read').update('owner', current => {
      const next = structuredClone(current!)
      const through = new Map(Object.entries(next.through))
      for (const item of items) through.set(item.sessionId, Math.max(through.get(item.sessionId) ?? -1, item.throughSeq))
      next.through = Object.fromEntries(through)
      next.revision++
      return next
    })
    return { ok: true }
  }

  /** @param signal - Stream cancellation. @returns Baseline then coalesced changed rows and durable read state. */
  @Remote({ name: 'follow', mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ActivityFrame> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const ids = new Set<SessionId>()
    let dirty = true; let first = true; let wake: (() => void) | undefined
    const notify = (id: SessionId | null): void => { if (id !== null) ids.add(id); dirty = true; wake?.() }
    this.listeners.add(notify)
    const abort = (): void => { wake?.() }
    combined.addEventListener('abort', abort)
    try {
      while (!combined.aborted) {
        if (dirty) {
          dirty = false
          const changed = first ? [...new Set([...this.summaries.keys(), ...this.live.keys(), ...this.failures])] : [...ids]
          ids.clear()
          const frame = this.frame(first, changed); first = false
          yield structuredClone(frame)
        } else await new Promise<void>(resolve => { wake = resolve; if (dirty || combined.aborted) resolve() })
      }
    } finally { this.listeners.delete(notify); combined.removeEventListener('abort', abort) }
  }
}
