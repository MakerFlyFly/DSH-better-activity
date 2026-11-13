/** Keyless browser matrix: native approvals, delegated tasks, lifecycle controls and pagination. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '../../packages/activity/src/index.ts'

const provider = 'activity-browser-fixture'
const approvalTool = 'activity_browser_approval_probe'
interface Case { key: string; id: SessionId; title: string; expectedStatus: string; parent?: SessionId; archived?: boolean }
interface Saved { cases: Case[]; lastCommandId?: string }
interface Command { id: string; action: 'start' | 'retry' | 'complete' | 'start-tree' | 'archive' | 'hydrate'; target: string }
export const name = 'better-activity-browser-matrix'
export const inject = ['betterActivity', 'workspaceRegistry', 'sessions', 'sessionController', 'sessionTitle', 'sessionPersistence', 'agents', 'llm', 'tools', 'subagents', 'approval']

/**
 * Mount only in an isolated test profile. Commands are {id, action, target} JSON in root/browser-command.json.
 * Targets are report case keys; complete also accepts all. Approval and tree runs start on explicit commands.
 * @param ctx - The real profile's native services.
 * @param config - Isolated fixture directory, report path and optional installed runtime directory.
 */
export async function apply(ctx: Context, config: { root: string; report: string; runtimeDirectory?: string }): Promise<void> {
  await mkdir(config.root, { recursive: true })
  const source = config.runtimeDirectory ? pathToFileURL(createRequire(join(config.runtimeDirectory, 'package.json')).resolve('@deepseek-ai/dsh-llm')).href : '@deepseek-ai/dsh-llm'
  const { LlmAdapter, ToolCallId, createAssistantMessage, createUserMessage }: typeof import('@deepseek-ai/dsh-llm') = await import(source)
  const lifetime = new AbortController()
  const statePath = join(config.root, 'browser-fixture.json'), commandPath = join(config.root, 'browser-command.json')
  const holds = new Map<SessionId, () => void>(), asked = new Set<SessionId>()
  let approvalsAsked = 0, approvedExecutions = 0
  const activations: SubagentActivation[] = []
  let saved: Saved = { cases: [] }
  try { saved = JSON.parse(await readFile(statePath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const firstBoot = saved.cases.length === 0
  let lastCommand: { command: Command; ok: boolean; error?: string } | undefined
  let reportTail = Promise.resolve()
  const persist = () => writeFile(statePath, JSON.stringify(saved, null, 2))
  const report = (): Promise<void> => {
    const run = reportTail.then(async () => {
      const snapshot = await ctx.betterActivity.snapshot()
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
      const hidden = (item: Case): boolean => {
        const seen = new Set<SessionId>()
        for (let current: Case | undefined = item; current && !seen.has(current.id); current = saved.cases.find(parent => parent.id === current!.parent)) {
          if (archived.has(current.id)) return true
          seen.add(current.id)
        }
        return false
      }
      await writeFile(config.report, JSON.stringify({ ok: true, commandPath, statePath, holds: [...holds.keys()], lastCommand, hydrationFailures: snapshot.failures, approvalAudit: { asked: approvalsAsked, executed: approvedExecutions },
        limitations: ['Stock DSH rejects delegated user questions (DELEGATED_CALLER) and approval-based permission expansion. This fixture uses real running descendants; pending-child navigation is covered only by deterministic UI tests.'],
        cases: saved.cases.map(item => ({ ...item, archived: archived.has(item.id), expectedStatus: hidden(item) ? 'hidden with archived ancestor' : item.title === '二级子任务提问验证' ? 'legacy fixture: completed after stock rejected its delegated question' : item.expectedStatus,
          agentStatus: ctx.agents.get(item.id)?.status ?? 'not-loaded', summary: snapshot.entries.find(entry => entry.sessionId === item.id)?.summary })),
      }, null, 2))
    })
    reportTail = run.catch(error => { ctx.logger.warn('Browser fixture report failed: %s', String(error)) })
    return run
  }
  function textChunks(text: string): StreamChunk[] {
    return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
  }
  function callChunks(name: string, args: object): StreamChunk[] {
    const id = ToolCallId(randomUUID()), argumentsDelta = JSON.stringify(args)
    return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsDelta } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
  }
  class BrowserAdapter extends LlmAdapter {
    override async listModels(): Promise<readonly LlmModelInfo[]> {
      return ['hold', 'approval', 'complete'].map(id => ({ provider, id, name: `Browser matrix · ${id}` }))
    }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.purpose) { yield* textChunks('本地浏览器验证'); return }
      const id = options.sessionId as SessionId | undefined
      assert.ok(id, 'Browser fixture model requires a native Session')
      if (options.model === 'approval' && !asked.has(id)) {
        asked.add(id)
        yield* callChunks(approvalTool, {})
        return
      }
      if (options.model !== 'hold') { yield* textChunks(options.model === 'approval' ? '审批流程已结束，测试没有执行外部操作。' : '本地浏览器验证已完成。'); return }
      const text = '正在等待本地浏览器验证操作，可以停止或通过文件命令完成。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      let resolve!: () => void
      let doneOnExit!: () => void
      const held = new Promise<void>((done, reject) => {
        resolve = done
        const abort = () => reject(options.signal?.reason ?? new Error('Browser fixture turn cancelled'))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
        doneOnExit = () => options.signal?.removeEventListener('abort', abort)
      })
      holds.set(id, resolve)
      void report()
      try { await held }
      finally { holds.delete(id); doneOnExit() }
      const complete = text + '验证已经完成。'
      yield { type: 'text-delta', index: 0, text: '验证已经完成。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: complete } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([provider], new BrowserAdapter()), 'browser fixture model')
  ctx.effect(() => ctx.tools.register({ name: approvalTool, description: 'Complete a harmless local activity verification after approval.', parameters: {},
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, render: () => [{ type: 'text', text: 'Local approval probe completed without external operations.' }] },
    async execute() { approvedExecutions++; return { ok: true } },
  }, { when: ({ modelSelection }) => modelSelection.provider === provider }), 'browser fixture approval tool')
  ctx.on('tools/pre-execute', (exec, next) => exec.name === approvalTool
    ? Promise.resolve({ kind: 'ask' as const, reason: 'ACTIVITY_BROWSER_APPROVAL', displayReason: { en: 'Allow the harmless local activity test?', zh: '允许完成这个安全的本地活动测试？' } }) : next(), { prepend: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') asked.delete(session.id)
    if (event.type === 'approval/asked' && event.data.toolName === approvalTool) approvalsAsked++
    if (saved.cases.some(item => item.id === session.id) && ['turn/start', 'turn/end', 'approval/asked', 'approval/decided'].includes(event.type)) void report()
  })

  const directory = join(config.root, 'browser-matrix'); await mkdir(directory, { recursive: true })
  const workspace = await ctx.workspaceRegistry.create(directory, '浏览器全量验证')
  const installedAt = (await ctx.betterActivity.snapshot()).read.installedAt
  async function create(key: string, title: string, model: string, historical = false): Promise<Case> {
    const result = await ctx.sessionController.create({ workspaceId: workspace.id })
    const agent = ctx.agents.get(result.sessionId); assert.ok(agent)
    agent.model.select({ provider, model })
    const item: Case = { key, id: result.sessionId, title, expectedStatus: historical ? 'completed, read' : 'blank until native prompt' }
    saved.cases.push(item)
    // Interactive rows enter only through native prompt, which owns the Agent's turn counters.
    if (historical) {
      const originalNow = Date.now
      try {
        Date.now = () => installedAt - 3 * 86_400_000
        agent.session.append('turn/start', { turn: 1 })
        agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: title }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        agent.session.append('step/start', { turn: 1, step: 1 })
        agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: `第 ${key.slice(5)} 条历史活动，验证分页和滚动稳定性。` }], source: { provider, model } }) }, { surfaceOp: 'append' })
        agent.session.append('step/end', { turn: 1, step: 1 })
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      } finally { Date.now = originalNow }
    }
    ctx.sessionTitle.rename(agent.session, title)
    return item
  }
  if (firstBoot) {
    for (let index = 1; index <= 65; index++) await create(`bulk-${index}`, `分页验证 ${String(index).padStart(2, '0')}`, 'complete', true)
    await create('approval', '审批验证：安全的本地测试', 'approval')
    await create('stoppable', '停止与再次运行验证', 'hold')
    await create('interruption', '服务重启中断验证', 'hold')
    await create('tree', '多级子任务归档验证', 'hold')
    await persist()
  }
  const byKey = (key: string): Case => { const item = saved.cases.find(item => item.key === key); assert.ok(item, 'Unknown browser fixture case: ' + key); return item }
  async function prompt(item: Case): Promise<void> {
    assert.equal(item.parent, undefined, 'Use the native child view to resume a delegated task')
    item.expectedStatus = item.key === 'approval' ? 'attention after native approval starts' : 'running'
    await ctx.sessionController.prompt({ sessionId: item.id, requestId: randomUUID() as SessionRequestId, mode: 'queue', content: [{ type: 'text', text: '继续本地浏览器验证' }] }, lifetime.signal)
  }
  async function startTree(): Promise<void> {
    assert.ok(!saved.cases.some(item => item.key === 'tree-child'), 'This fixture tree already exists; archive or inspect its recorded identities')
    const root = byKey('tree'); await prompt(root)
    const parent = ctx.agents.get(root.id); assert.ok(parent)
    const child = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', parent, signal: lifetime.signal, maxDepth: 2, name: 'level-one', label: '一级子任务验证', prompt: [{ type: 'text', text: '保持这个本地测试子任务运行。' }], agentOptions: { provider, model: 'hold' } })
    activations.push(child)
    const childAgent = ctx.agents.get(child.childId); assert.ok(childAgent)
    ctx.sessionTitle.rename(childAgent.session, '一级子任务验证')
    saved.cases.push({ key: 'tree-child', id: child.childId, parent: root.id, title: '一级子任务验证', expectedStatus: 'running; aggregated into tree' })
    const grandchild = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', parent: childAgent, signal: lifetime.signal, maxDepth: 2, name: 'level-two', label: '二级子任务运行验证', prompt: [{ type: 'text', text: '保持这个本地测试孙任务运行，等待完成命令。' }], agentOptions: { provider, model: 'hold' } })
    activations.push(grandchild)
    const grandchildAgent = ctx.agents.get(grandchild.childId); assert.ok(grandchildAgent)
    ctx.sessionTitle.rename(grandchildAgent.session, '二级子任务运行验证')
    saved.cases.push({ key: 'tree-grandchild', id: grandchild.childId, parent: child.childId, title: '二级子任务运行验证', expectedStatus: 'running; aggregated into tree' })
    for (const activation of [child, grandchild]) void activation.result.catch(error => { if (!lifetime.signal.aborted) ctx.logger.warn('Browser fixture child failed: %s', String(error)) })
    await persist()
  }
  async function execute(command: Command): Promise<void> {
    if (command.action === 'start-tree') { await startTree(); return }
    if (command.action === 'hydrate') {
      const ids = command.target === 'all' ? saved.cases.map(item => item.id) : [byKey(command.target).id]
      const batchSize = (await ctx.betterActivity.snapshot()).hydrateBatchSize
      for (let index = 0; index < ids.length; index += batchSize) {
        const result = await ctx.betterActivity.hydrate({ sessionIds: ids.slice(index, index + batchSize) }, lifetime.signal)
        assert.deepEqual(result.failures, [], 'Browser fixture history must recover without summary failures')
      }
      return
    }
    if (command.action === 'complete') {
      const ids = command.target === 'all' ? [...holds.keys()] : command.target === 'tree' ? saved.cases.filter(item => item.key.startsWith('tree')).map(item => item.id) : [byKey(command.target).id]
      for (const id of ids) holds.get(id)?.()
      return
    }
    const item = byKey(command.target)
    if (command.action === 'start' || command.action === 'retry') { await prompt(item); return }
    if (command.action === 'archive') { await ctx.workspaceRegistry.archiveSession(item.id, { stopActivity: true }); item.archived = true; item.expectedStatus = 'hidden with descendants'; return }
    throw new Error('Unknown browser fixture action')
  }
  let polling: Promise<void> = Promise.resolve()
  ctx.effect(() => async () => {
    lifetime.abort()
    for (const item of saved.cases) ctx.agents.get(item.id)?.cancel({ kind: 'user' })
    await Promise.allSettled(activations.map(item => item.dispose()))
    await polling
    await Promise.allSettled(saved.cases.flatMap(item => { const agent = ctx.agents.get(item.id); return agent ? [agent.whenIdle()] : [] }))
    await ctx.sessionPersistence.flush()
    await reportTail
  }, 'browser fixture lifetime')
  if (firstBoot) { await prompt(byKey('stoppable')); await prompt(byKey('interruption')) }
  await ctx.sessionPersistence.flush(); await report()
  polling = (async () => {
    while (!lifetime.signal.aborted) {
      try {
        const command: Command = JSON.parse(await readFile(commandPath, 'utf8'))
        if (typeof command.id !== 'string' || typeof command.target !== 'string') throw new Error('Browser fixture command requires id and target')
        if (command.id !== saved.lastCommandId) {
          try { await execute(command); lastCommand = { command, ok: true } }
          catch (error) { lastCommand = { command, ok: false, error: String(error) } }
          saved.lastCommandId = command.id
          await persist(); await ctx.sessionPersistence.flush(); await report()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !lifetime.signal.aborted) ctx.logger.warn('Browser fixture command failed: %s', String(error))
      }
      try { await setTimeout(200, undefined, { signal: lifetime.signal }) }
      catch (error) { if (!lifetime.signal.aborted) throw error }
    }
  })()
}
