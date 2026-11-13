/** Test-only real Loader driver. Seeds durable conversations without model calls. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '../../packages/activity/src/index.ts'
import { summaryCases } from './summary-cases.ts'

export const name = 'better-activity-fixture'
export const inject = ['betterActivity', 'workspaceRegistry', 'sessions', 'sessionTitle', 'sessionController', 'sessionPersistence', 'sessionQuery', 'sessionProjections', 'llm', 'agents']
export async function apply(ctx: Context, config: { root: string; report: string; runtimeDirectory?: string; verify?: boolean; live?: boolean; summaryCases?: boolean; preserveRead?: boolean }): Promise<void> {
  const checks: string[] = []
  try {
    const messageModule = config.runtimeDirectory
      ? pathToFileURL(createRequire(join(config.runtimeDirectory, 'package.json')).resolve('@deepseek-ai/dsh-llm')).href
      : '@deepseek-ai/dsh-llm'
    const { createAssistantMessage, createUserMessage }: Pick<typeof import('@deepseek-ai/dsh-llm'), 'createAssistantMessage' | 'createUserMessage'> = await import(messageModule)
    await mkdir(config.root, { recursive: true })
    const ledger = await ctx.betterActivity.snapshot()
    const seedFile = join(config.root, 'activity-fixture.json')
    let ids: SessionId[] | undefined
    let summaryIds: Record<string, SessionId> = {}
    try {
      const saved = JSON.parse(await readFile(seedFile, 'utf8'))
      ids = saved.ids; summaryIds = saved.summaryIds ?? {}
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!ids) {
      ids = []
      const projects = []
      for (const [directory, title] of [['harness', 'DSH'], ['design', '产品设计'], ['research', '研究项目']]) {
        const path = join(config.root, directory!); await mkdir(path, { recursive: true })
        projects.push(await ctx.workspaceRegistry.create(path, title))
      }
      const cases = [
        ['同步上游并添加活动视图', '已确认本地 DSH 与官方上游一致，活动视图和多窗口同步已接入。'],
        ['整理插件验证结果', '已经整理测试结果，补齐了安装说明和兼容性记录。'],
        ['改进错误恢复', '连接已断开，请检查网络后重试。已完成的结果保持不变。'],
        ['侧栏排版评审', '标题与项目名称保持在同一行，摘要最多显示两行。'],
        ['一条很长的会话标题：检查窄侧栏中的项目名称、摘要、状态图标与键盘焦点是否相互遮挡', '这是用于验证中英文、Emoji 🌊 和长单词 supercalifragilisticexpialidocious 在狭窄布局中正常换行的会话摘要。'],
        ['研究笔记', '整理了实验观察和后续需要比较的数据。'],
        ['发布说明', '已更新功能说明，准备了可独立安装的插件包。'],
        ['历史讨论', '保留之前的讨论内容和上下文，便于继续查看。'],
      ]
      for (const [index, [title, text]] of cases.entries()) {
        const created = await ctx.sessionController.create({ workspaceId: projects[index % projects.length]!.id })
        const session = ctx.sessions.get(created.sessionId); assert.ok(session)
        const time = index < 3 ? Date.now() : ledger.read.installedAt - (index - 2) * 86_400_000
        const now = Date.now
        try {
          Date.now = () => time
          session.append('turn/start', { turn: 1 })
          session.append('user/message', createUserMessage({ content: [{ type: 'text', text: title! }], source: { kind: 'user' } }), { surfaceOp: 'append' })
          session.append('step/start', { turn: 1, step: 1 })
          session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: text! }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
          session.append('step/end', { turn: 1, step: 1 })
          session.append('turn/end', { turn: 1, reason: index === 2 ? { kind: 'error', error: { code: 'FIXTURE_CONNECTION', message: text! } } : { kind: 'completed' } })
        } finally { Date.now = now }
        ctx.sessionTitle.rename(session, title!)
        ids.push(created.sessionId)
      }
      await ctx.sessionPersistence.flush()
      await writeFile(seedFile, JSON.stringify({ ids, summaryIds }))
    }
    if (config.summaryCases) {
      const directory = join(config.root, 'summary-cases'); await mkdir(directory, { recursive: true })
      const project = await ctx.workspaceRegistry.create(directory, '摘要验证')
      for (const sample of summaryCases) {
        if (summaryIds[sample.id] !== undefined) continue
        const created = await ctx.sessionController.create({ workspaceId: project.id })
        const session = ctx.sessions.get(created.sessionId); assert.ok(session)
        session.append('turn/start', { turn: 1 })
        session.append('user/message', createUserMessage({ content: [{ type: 'text', text: sample.title }], source: { kind: 'user' } }), { surfaceOp: 'append' })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: sample.text }], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        ctx.sessionTitle.rename(session, sample.title)
        summaryIds[sample.id] = created.sessionId
      }
      await ctx.sessionPersistence.flush()
      await writeFile(seedFile, JSON.stringify({ ids, summaryIds }))
    }
    const readBeforeHydration = (await ctx.betterActivity.snapshot()).read
    await ctx.betterActivity.hydrate({ sessionIds: [...ids, ...Object.values(summaryIds)] }, new AbortController().signal)
    const hydrated = await ctx.betterActivity.snapshot()
    const summaryResults = []
    for (const sample of summaryCases) {
      if (summaryIds[sample.id] === undefined) continue
      const sessionId = summaryIds[sample.id]!
      const entry = hydrated.entries.find(item => item.sessionId === sessionId)
      assert.ok(entry, `Missing summary for ${sample.id}`)
      const projection = await ctx.sessionQuery.inspectSession(sessionId, session => ctx.sessionProjections.checkpoint(session).betterActivity)
      assert.ok(projection)
      assert.deepEqual(projection.val, entry.summary)
      summaryResults.push({ id: sample.id, sessionId, summary: entry.summary, projectionVersion: projection.ver })
    }
    checks.push('real Loader, Workspace, Session events and activity projection')
    if (config.verify) {
      const primary = ids[0]!
      const before = hydrated
      const first = before.entries.find(entry => entry.sessionId === primary)!
      assert.match(first.summary.preview, /上游/)
      const acknowledged = before.read.through[primary]
      if (acknowledged !== undefined) {
        assert.equal(acknowledged, first.summary.terminalSeq)
        checks.push('read acknowledgement survives real Host restart')
      }
      if (config.preserveRead) {
        assert.equal(acknowledged, first.summary.terminalSeq)
        assert.deepEqual(hydrated.read, ledger.read)
        assert.deepEqual(readBeforeHydration, ledger.read)
        checks.push('summary hydration does not write read state')
      } else {
        const abort = new AbortController()
        const stream = ctx.betterActivity.follow(abort.signal)[Symbol.asyncIterator]()
        assert.equal((await stream.next()).value.reset, true)
        const results = await Promise.all([
          ctx.betterActivity.markRead([{ sessionId: primary, throughSeq: first.summary.terminalSeq }]),
          ctx.betterActivity.markRead([{ sessionId: primary, throughSeq: Math.max(0, first.summary.terminalSeq - 1) }]),
        ])
        assert.ok(results.every(result => result.ok))
        assert.equal((await ctx.betterActivity.snapshot()).read.through[primary], first.summary.terminalSeq)
        const update = await stream.next(); assert.equal(update.value.reset, false)
        abort.abort(); await stream.return?.()
        checks.push('concurrent acknowledgements never move the watermark backwards')
        checks.push('follow publishes committed read state and cancels')
      }
      const invalid = await ctx.betterActivity.markRead([{ sessionId: primary, throughSeq: first.summary.terminalSeq + 100 }])
      assert.equal(invalid.ok, false)
      assert.equal((await ctx.betterActivity.snapshot()).read.through[primary], first.summary.terminalSeq)
      checks.push('future acknowledgement is rejected without changing read state')
      if (config.summaryCases && !config.preserveRead) {
        const sample = summaryResults[0]; assert.ok(sample)
        assert.equal((await ctx.betterActivity.markRead([{ sessionId: sample.sessionId, throughSeq: sample.summary.terminalSeq }])).ok, true)
      }
    }
    await ctx.sessionPersistence.flush()
    const liveIds = config.live ? await (await import('./live.ts')).startLive(ctx, config.root, config.runtimeDirectory) : []
    const finalRead = (await ctx.betterActivity.snapshot()).read
    await writeFile(config.report, JSON.stringify({ ok: true, checks, ids, liveIds, summaryResults, initialRead: ledger.read, readBeforeHydration, readAfterHydration: hydrated.read, finalRead }, null, 2))
  } catch (error) {
    await writeFile(config.report, JSON.stringify({ ok: false, checks, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2))
    throw error
  }
}
