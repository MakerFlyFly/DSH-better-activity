/** Real-runtime probe for an unfinished durable turn across a process loss. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const inject = ['betterActivity', 'workspaceRegistry', 'sessionController', 'sessions', 'sessionPersistence']

async function publish(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2))
  await rename(path + '.tmp', path)
}

async function stored(ctx, sessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try { return (await handle.read(0)).events }
  finally { await handle.close() }
}
const fingerprint = events => createHash('sha256').update(JSON.stringify(events)).digest('hex')

export async function apply(ctx, config) {
  try {
    const checks = []
    const statePath = join(config.root, 'unfinished.json')
    await mkdir(config.root, { recursive: true })
    if (config.stage === 'seed') {
      const source = pathToFileURL(createRequire(join(config.runtimeDirectory, 'package.json')).resolve('@deepseek-ai/dsh-llm')).href
      const { createAssistantMessage, createUserMessage } = await import(source)
      const directory = join(config.root, 'project'); await mkdir(directory, { recursive: true })
      const project = await ctx.workspaceRegistry.create(directory, 'Recovery fixture')
      const { sessionId } = await ctx.sessionController.create({ workspaceId: project.id })
      const session = ctx.sessions.get(sessionId); assert.ok(session)
      const appendTurn = (turn, text) => {
        session.append('turn/start', { turn })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect recovery' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        session.append('step/start', { turn, step: 1 })
        session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
          content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' },
        }) }, { surfaceOp: 'append' })
      }
      appendTurn(1, 'Previous completed result')
      session.append('step/end', { turn: 1, step: 1 })
      const completed = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      assert.equal((await ctx.betterActivity.markRead([{ sessionId, throughSeq: completed.seq }])).ok, true)
      appendTurn(2, 'Public progress before process loss')
      await ctx.sessionPersistence.flush()
      const events = await stored(ctx, sessionId)
      assert.equal(events.some(event => event.type === 'turn/end' && event.data.turn === 2), false)
      const snapshot = await ctx.betterActivity.snapshot()
      const summary = snapshot.entries.find(entry => entry.sessionId === sessionId)?.summary
      assert.equal(summary?.outcome, 'running')
      assert.equal(snapshot.read.through[sessionId], completed.seq)
      const state = { sessionId, eventHash: fingerprint(events), tip: events.at(-1).seq, read: snapshot.read, summary }
      await publish(statePath, state)
      checks.push('unfinished turn is durably stored after an acknowledged earlier result')
      await publish(config.report, { ok: true, checks, ...state })
      return
    }
    const saved = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(ctx.sessions.get(saved.sessionId), undefined)
    const before = await stored(ctx, saved.sessionId)
    assert.equal(fingerprint(before), saved.eventHash)
    assert.equal(before.some(event => event.type === 'turn/end' && event.data.turn === 2), false)
    assert.deepEqual((await ctx.betterActivity.snapshot()).read, saved.read)
    const hydrated = await ctx.betterActivity.hydrate({ sessionIds: [saved.sessionId] }, new AbortController().signal)
    const summary = hydrated.entries.find(entry => entry.sessionId === saved.sessionId)?.summary
    assert.equal(summary?.outcome, 'interrupted')
    assert.equal(summary.preview, saved.summary.preview)
    assert.ok(summary.terminalSeq > saved.tip)
    assert.ok(summary.terminalAt >= saved.read.installedAt)
    assert.ok(saved.read.through[saved.sessionId] < summary.terminalSeq)
    assert.deepEqual(hydrated.read, saved.read)
    assert.equal(ctx.sessions.get(saved.sessionId), undefined)
    assert.equal(fingerprint(await stored(ctx, saved.sessionId)), saved.eventHash)
    const repeated = await ctx.betterActivity.hydrate({ sessionIds: [saved.sessionId] }, new AbortController().signal)
    assert.deepEqual(repeated.entries.find(entry => entry.sessionId === saved.sessionId)?.summary, summary)
    assert.deepEqual(repeated.read, saved.read)
    checks.push('fresh official Host restores interrupted status from the unfinished stored turn')
    checks.push('an older read watermark leaves the new interruption unread')
    checks.push('summary recovery neither activates the Session nor writes synthetic closers to its log')
    checks.push('repeat hydration keeps the recovered terminal position and read ledger stable')
    await publish(config.report, { ok: true, checks, sessionId: saved.sessionId, summary, read: repeated.read, eventHash: saved.eventHash })
  } catch (error) {
    await publish(config.report, { ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined })
    throw error
  }
}
