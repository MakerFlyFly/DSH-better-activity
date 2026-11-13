import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { StorageError, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionStore, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createAssistantMessage, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BetterActivity from '../packages/activity/lib/index.js'
import { summaryCases } from './fixtures/summary-cases.ts'
import { isUnread } from '../packages/activity/src/client/model.ts'
import type { ActivityEntry } from '../packages/activity/src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function bench() {
  const parent = resolve('.dev/host-tests'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'case-'))
  const ctx = new Context()
  await ctx.plugin(Storage); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  const backend = new JsonStorageBackend(root)
  let failing = false; let denied: SessionId | undefined
  let writeBarrier: { entered: ReturnType<typeof Promise.withResolvers<void>>; released: ReturnType<typeof Promise.withResolvers<void>> } | undefined
  const fault: StorageBackend = {
    kv: { open: async descriptor => {
      const unit = await backend.kv.open(descriptor)
      return new Proxy(unit, { get(target, property) {
        if (property === 'putRecord') return async (...args: Parameters<typeof unit.putRecord>) => {
          if (failing) throw new StorageError('malformed-medium', 'Simulated read-ledger write failure')
          if (writeBarrier) {
            const barrier = writeBarrier; writeBarrier = undefined
            barrier.entered.resolve(); await barrier.released.promise
          }
          return target.putRecord(...args)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }, close: () => backend.close(),
  }
  ctx.storage.backend.register('test', fault)
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'test' }))
  ctx.provide('typert', {} as never)
  ctx.provide('agents', {} as never)
  ctx.provide('remoteAccess', { allows: ({ id }: { id: SessionId }) => id !== denied } as never)
  ctx.provide('sessionQuery', { inspectSession: async <T>(id: SessionId, read: (session: Session) => T) => {
    const session = ctx.sessions.get(id)
    if (!session) throw new Error('Missing fixture session')
    return read(session)
  } } as never)
  const fiber = ctx.plugin(BetterActivity, { previewIntervalMs: 1 }); await fiber.await()
  const service = ctx.get('betterActivity')!
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  cleanups.push(async () => { await ctx.fiber.dispose(); await backend.close() })
  return { ctx, service, session, fiber, fail: (value: boolean) => { failing = value }, deny: (id: SessionId) => { denied = id }, holdNextWrite: () => {
    const barrier = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }
    writeBarrier = barrier
    return { entered: barrier.entered.promise, release: () => barrier.released.resolve() }
  } }
}

describe('activity Host ownership', () => {
  it('publishes monotone read state to two followers when a new result arrives during an older acknowledgement write', async () => {
    const h = await bench(), cancel = new AbortController()
    const viewers = [h.service.follow(cancel.signal)[Symbol.asyncIterator](), h.service.follow(cancel.signal)[Symbol.asyncIterator]()]
    await Promise.all(viewers.map(viewer => viewer.next()))
    const barrier = h.holdNextWrite()
    const older = h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])
    try {
      await barrier.entered
      h.session.append('turn/start', { turn: 2 })
      h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const pending = await Promise.all(viewers.map(viewer => viewer.next()))
      for (const update of pending) {
        expect(update.value.entries[0]?.summary.terminalSeq).toBe(3)
        expect(update.value.read.through[h.session.id]).toBeUndefined()
      }
      barrier.release(); expect(await older).toEqual({ ok: true })
      const observed = await Promise.all(viewers.map(viewer => viewer.next()))
      const current = (await h.service.snapshot()).entries.find((entry: ActivityEntry) => entry.sessionId === h.session.id)!.summary
      for (const update of observed) {
        expect(update.value.read.through[h.session.id]).toBe(1)
        expect(isUnread(current, h.session.id, update.value.read)).toBe(true)
      }
      await Promise.all([
        h.service.markRead([{ sessionId: h.session.id, throughSeq: 3 }]),
        h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }]),
      ])
      const settled = await Promise.all(viewers.map(viewer => viewer.next()))
      expect(settled[0]!.value.read).toEqual(settled[1]!.value.read)
      for (const update of settled) {
        expect(update.value.read.through[h.session.id]).toBe(3)
        expect(isUnread(current, h.session.id, update.value.read)).toBe(false)
      }
    } finally {
      barrier.release(); await older; cancel.abort(); await Promise.all(viewers.map(viewer => viewer.return?.()))
    }
  })
  it.each(summaryCases)('keeps streamed and committed summaries consistent for $id', async ({ id, text, preview }) => {
    const h = await bench()
    h.session.append('turn/start', { turn: 2 }); h.session.append('step/start', { turn: 2, step: 1 })
    const agent = { id: h.session.id, session: h.session } as Agent
    const emit = (frame: AssistantStreamFrame) => h.ctx.emit('agent/assistant-stream', { agent, frame })
    const attemptId = LlmAttemptId(id)
    emit({ type: 'start', attemptId, revision: 1, turn: 2, step: 1 })
    const midpoint = Math.floor(text.length / 2)
    for (const [index, chunk] of [text.slice(0, midpoint), text.slice(midpoint)].entries()) {
      emit({ type: 'chunk', attemptId, revision: index + 2, index, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: chunk } })
    }
    expect((await h.service.snapshot()).previews.find(item => item.sessionId === h.session.id)?.text).toBe(preview)
    const event = h.session.append('assistant/message', { turn: 2, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    emit({ type: 'end', attemptId, revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
    const frame = await h.service.snapshot()
    expect(frame.previews.find(item => item.sessionId === h.session.id)?.text).toBe('')
    expect(frame.entries.find(item => item.sessionId === h.session.id)?.summary)
      .toMatchObject({ preview, seq: event.seq, activityAt: event.time })
  })

  it('versions live preview changes before the notification timer runs', async () => {
    const h = await bench(), abort = new AbortController()
    const stream = h.service.follow(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    const agent = { id: h.session.id, session: h.session } as Agent
    const emit = (frame: AssistantStreamFrame) => h.ctx.emit('agent/assistant-stream', { agent, frame })
    const attemptId = LlmAttemptId('activity-preview-test')
    vi.useFakeTimers()
    try {
      emit({ type: 'start', attemptId, revision: 1, turn: 2, step: 1 })
      emit({ type: 'chunk', attemptId, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'first' } })
      const first = await h.service.snapshot()
      const notification = stream.next()
      emit({ type: 'chunk', attemptId, revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: ' second' } })
      const second = await h.service.hydrate({ sessionIds: [h.session.id] }, abort.signal)
      expect(second.revision).toBeGreaterThan(first.revision)
      expect(first.previews[0]?.text).toBe('first')
      expect(second.previews[0]?.text).toBe('first second')
      await vi.advanceTimersByTimeAsync(1)
      expect((await notification).value).toMatchObject({ revision: second.revision, previews: second.previews })
    } finally {
      abort.abort(); await stream.return?.(); vi.useRealTimers()
    }
  })

  it('acknowledges an opened historical conversation before background hydration has reached it', async () => {
    const h = await bench()
    await h.fiber.dispose()
    const next = h.ctx.plugin(BetterActivity); await next.await()
    const service = h.ctx.get('betterActivity')!
    expect((await service.snapshot()).entries).toEqual([])
    expect(await service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])).toEqual({ ok: true })
    expect((await service.snapshot()).read.through[h.session.id]).toBe(1)
  })

  it('does not republish unchanged summaries when another viewer hydrates the same history', async () => {
    const h = await bench(), abort = new AbortController()
    const stream = h.service.follow(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    await h.service.hydrate({ sessionIds: [h.session.id] }, abort.signal)
    await h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])
    expect((await stream.next()).value.entries).toEqual([])
    abort.abort(); await stream.return?.()
  })

  it('does not publish or acknowledge a failed durable write', async () => {
    const h = await bench()
    const before = await h.service.snapshot()
    const changes: unknown[] = []
    h.ctx.on('domain/changed', event => { if (event.domain === 'better_activity') changes.push(event) })
    h.fail(true)
    await expect(h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])).rejects.toThrow('Simulated')
    expect((await h.service.snapshot()).read).toEqual(before.read)
    expect(changes).toEqual([])
    h.fail(false)
    expect(await h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])).toEqual({ ok: true })
    expect(changes).toHaveLength(1)
  })
  it('preserves a newer completion when an older viewed version is acknowledged', async () => {
    const h = await bench()
    h.session.append('turn/start', { turn: 2 }); h.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])
    const state = await h.service.snapshot()
    expect(state.entries[0]!.summary.terminalSeq).toBe(3)
    expect(state.read.through[h.session.id]).toBe(1)
    await h.service.markRead([{ sessionId: h.session.id, throughSeq: 3 }])
    await h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])
    expect((await h.service.snapshot()).read.through[h.session.id]).toBe(3)
  })
  it('isolates one unavailable historical summary and filters unauthorized resources', async () => {
    const h = await bench()
    const missing = 'missing-session' as SessionId
    const result = await h.service.hydrate({ sessionIds: [missing, h.session.id] }, new AbortController().signal)
    expect(result.failures).toEqual([missing])
    expect(result.entries.map(entry => entry.sessionId)).toEqual([h.session.id])
    h.deny(h.session.id)
    expect((await h.service.snapshot()).entries).toEqual([])
    expect(await h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])).toEqual({ ok: false, code: 'unavailable' })
  })
  it('reloads its ledger and releases a waiting subscriber on unload', async () => {
    const h = await bench()
    await h.service.markRead([{ sessionId: h.session.id, throughSeq: 1 }])
    const stream = h.service.follow(new AbortController().signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value.reset).toBe(true)
    const pending = stream.next()
    await h.fiber.dispose()
    expect((await pending).done).toBe(true)
    const next = h.ctx.plugin(BetterActivity); await next.await()
    expect((await h.ctx.get('betterActivity')!.snapshot()).read.through[h.session.id]).toBe(1)
  })
})
