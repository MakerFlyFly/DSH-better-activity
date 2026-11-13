/** Keyless model adapter exercising the real Agent loop and question UI in the preview profile. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'

/** @param ctx - Real preview Host. @param root - Isolated fixture directory. @returns Started Session identities. */
export async function startLive(ctx: Context, root: string, runtimeDirectory?: string): Promise<string[]> {
  const source = runtimeDirectory ? pathToFileURL(createRequire(join(runtimeDirectory, 'package.json')).resolve('@deepseek-ai/dsh-llm')).href : '@deepseek-ai/dsh-llm'
  const { LlmAdapter, ToolCallId, createUserMessage }: typeof import('@deepseek-ai/dsh-llm') = await import(source)
  class PreviewAdapter extends LlmAdapter {
    private readonly directory: string
    constructor(directory: string) { super(); this.directory = directory }
    override async listModels(): Promise<readonly LlmModelInfo[]> {
      return [{ provider: 'activity-preview', id: 'running', name: 'Activity test · progress' }, { provider: 'activity-preview', id: 'question', name: 'Activity test · question' }]
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.model === 'question' && !options.messages.some(message => message.role === 'tool')) {
        const text = '活动视图已经准备好，等待你选择下一步的测试。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        const callId = ToolCallId('activity-preview-question')
        const args = JSON.stringify({ timeout: -1, questions: [{ id: 'preview', question: '接下来先验证哪一种界面？', options: [{ label: '浅色界面', description: '检查摘要、分组和已读提示。' }, { label: '深色界面', description: '检查颜色、对比度和焦点。' }] }] })
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id: callId, name: 'ask_user_question', argumentsDelta: args }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      let text = options.model === 'running' ? '正在检查活动列表的更新、滚动位置和多窗口同步。' : '已收到测试选择，活动会话可以继续查看。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      if (options.model === 'running') {
        while (true) {
          options.signal?.throwIfAborted()
          try { await access(join(this.directory, 'finish-live')); break }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          await setTimeout(250, undefined, { signal: options.signal })
        }
        const suffix = '验证已经完成。'
        text += suffix
        yield { type: 'text-delta', index: 0, text: suffix }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }


  ctx.llm.registerAdapter(['activity-preview'], new PreviewAdapter(root))
  const project = ctx.workspaceRegistry.list()[0]!
  const ids: string[] = []
  for (const [model, title] of [['running', '验证活动视图的实时进展'], ['question', '活动视图交互确认']]) {
    const created = await ctx.sessionController.create({ workspaceId: project.id })
    const agent = ctx.agents.get(created.sessionId)!
    agent.model.select({ provider: 'activity-preview', model: model! })
    ctx.sessionTitle.rename(agent.session, title!)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: title! }], source: { kind: 'user' } }))
    ids.push(created.sessionId)
  }
  return ids
}
