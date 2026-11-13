import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/src/client/contract/slots.ts'
import { activityProjection, foldActivity, previewText } from '../packages/activity/src/domain/projection.ts'
import { deriveRows, dateBucket, isUnread } from '../packages/activity/src/client/model.ts'
import type { ActivitySummary } from '../packages/activity/src/types.ts'

const id = (text: string) => text as SessionId
const initial: ActivitySummary = { seq: -1, activityAt: 0, preview: '', outcome: 'idle', terminalSeq: -1, terminalAt: 0, engaged: false }
const read = { version: 1 as const, installedAt: 100, revision: 0, through: {} }
const finish = (seq: number, kind: 'completed' | 'interrupted' = 'completed'): SessionEvent<'turn/end'> => ({ type: 'turn/end', seq: SessionSeq(seq), time: 200, data: { turn: 1, reason: { kind } } })

describe('durable activity projection', () => {
  it('uses public assistant text, leaves tool-only output alone and bounds Unicode safely', () => {
    const event: SessionEvent<'assistant/message'> = { type: 'assistant/message', seq: SessionSeq(2), time: 200, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: '**公开进展** 🌊🌊' }], source: { provider: 'test', model: 'test' } }) } }
    const value = foldActivity(initial, event, 6)
    expect(value.preview).toBe('公开进展 🌊')
    expect(value.engaged).toBe(true)
    const unrelated: SessionEvent = { type: 'step/end', seq: SessionSeq(3), time: 250, data: { turn: 1, step: 1 } }
    expect(foldActivity(value, unrelated, 6)).toBe(value)
  })
  it('distinguishes completion, failure, cancellation and interruption', () => {
    expect(foldActivity(initial, finish(5), 240)).toMatchObject({ outcome: 'completed', terminalSeq: 5 })
    expect(foldActivity(initial, finish(5, 'interrupted'), 240).outcome).toBe('interrupted')
    const stopped: SessionEvent = { ...finish(6), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } }
    expect(foldActivity(initial, stopped, 240).outcome).toBe('stopped')
    const failed: SessionEvent = { ...finish(7), data: { turn: 1, reason: { kind: 'error', error: { code: 'TEST', message: 'failed' } } } }
    expect(foldActivity(initial, failed, 240).outcome).toBe('failed')
  })
  it('restoring a checkpoint and applying a suffix matches full replay', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 110, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 120, surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }) },
      finish(2),
    ]
    const apply = (state: ActivitySummary, event: SessionEvent) => foldActivity(state, event, 240)
    const checkpoint = JSON.parse(JSON.stringify(events.slice(0, 2).reduce(apply, initial)))
    expect(events.slice(2).reduce(apply, checkpoint)).toEqual(events.reduce(apply, initial))
  })
  it('does not re-alert historical results, but a newer event after acknowledgement remains unread', () => {
    const summary = foldActivity(initial, finish(8), 240)
    expect(isUnread({ ...summary, terminalAt: 50 }, id('a'), read)).toBe(false)
    expect(isUnread(summary, id('a'), { ...read, through: { a: 8 } })).toBe(false)
    expect(isUnread({ ...summary, terminalSeq: 9 }, id('a'), { ...read, through: { a: 8 } })).toBe(true)
    expect(isUnread({ ...summary, outcome: 'stopped' }, id('a'), read)).toBe(false)
  })
  it('removes formatting and leaves readable link labels', () => {
    expect(previewText('## 进展\n已完成 [测试](https://example.com)', 240)).toBe('进展 已完成 测试')
  })
  it('preserves identifiers and operators in prose and inline code', () => {
    expect(previewText('**已完成** snake_case、foo__bar__baz，`SELECT * FROM user_data WHERE a > 0`，_检查通过_', 240))
      .toBe('已完成 snake_case、foo__bar__baz，SELECT * FROM user_data WHERE a > 0，检查通过')
    expect(previewText('运行 ``printf `user_id` *ptr`` 与 a * b，使用 ~/.config', 240))
      .toBe('运行 printf `user_id` *ptr 与 a * b，使用 ~/.config')
  })
  it('preserves fenced code and unfinished streaming code without its language label', () => {
    expect(previewText('修改如下：\n```python\nuser_id = a * b\nif user_id > 0:\n    print("**done**")\n```\n**已完成**', 240))
      .toBe('修改如下： user_id = a * b if user_id > 0: print("**done**") 已完成')
    expect(previewText('~~~sql\nSELECT * FROM user_data\n~~~', 240)).toBe('SELECT * FROM user_data')
    expect(previewText('```c\nuser_id = *ptr', 240)).toBe('user_id = *ptr')
  })
  it.each([
    ['bold code', '已完成 **`user_id`** 字段', '已完成 user_id 字段'],
    ['linked code', '[打开 `my_project/result_v1.csv`](https://example.com/results)', '打开 my_project/result_v1.csv'],
    ['formatted link', '**[查看 `user_id`](https://example.com)**', '查看 user_id'],
    ['code punctuation', '**`[user_id](local) *ptr`**', '[user_id](local) *ptr'],
    ['multiple backticks', '```inline `x` code``` 后续说明', 'inline `x` code 后续说明'],
    ['inline code at line start', '```my_file.ts```', 'my_file.ts'],
    ['longer closing fence', '```ts\nconst user_id = 1\n````\n**Done**', 'const user_id = 1 Done'],
    ['tilde fence with CRLF', '~~~sql\r\nSELECT * FROM user_data\r\n~~~~\r\n**完成**', 'SELECT * FROM user_data 完成'],
    ['unclosed inline code', '正在检查 `my_project/user_id', '正在检查 `my_project/user_id'],
    ['unequal inline delimiters', '`user_id``', '`user_id``'],
    ['escaped opening delimiter', '\\`user_id`', '\\`user_id`'],
    ['source placeholder characters', '\u00000\u0000 **`user_id`** \u00001\u0000', '\u00000\u0000 user_id \u00001\u0000'],
  ])('keeps the readable summary for %s', (_name, input, expected) => {
    expect(previewText(input, 240)).toBe(expected)
  })
  it('restores protected code before applying the Unicode preview limit', () => {
    expect(previewText('**`🌊user_id`** 后续说明', 5)).toBe('🌊user')
  })
  it('replaces the previous preview and activity position for a message beginning with inline code', () => {
    const event: SessionEvent<'assistant/message'> = { type: 'assistant/message', seq: SessionSeq(9), time: 300, surfaceOp: 'append', data: {
      turn: 2, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: '```my_file.ts``` 后续说明' }], source: { provider: 'test', model: 'test' } }),
    } }
    expect(foldActivity({ ...initial, seq: 4, activityAt: 200, preview: '上一条摘要' }, event, 240))
      .toMatchObject({ preview: 'my_file.ts 后续说明', seq: 9, activityAt: 300 })
  })
  it('invalidates old cached previews while keeping the published summary shape', () => {
    const projection = activityProjection(240)
    expect(projection.stateVersion).toBe(3_000_000 + 240)
    expect(projection.wire.viewSchema.parse(initial)).toEqual(initial)
  })
  it('treats an opaque identity matching a built-in object property as unread until acknowledged', () => {
    expect(isUnread(foldActivity(initial, finish(8), 240), id('constructor'), read)).toBe(true)
  })
})

describe('calendar and cross-conversation list', () => {
  it('moves an approval through running, unread completion, reading and another turn', () => {
    const sessionId = id('approval-transition')
    const list: SessionListState = { phase: 'ready', ids: [sessionId], byId: {
      [sessionId]: { id: sessionId, displayTitle: 'Task', blank: false, running: true, retainedBy: {}, updatedAt: 150 },
    }, projectionsBySession: {} }
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [], pinnedSessionIds: [] } as WorkspaceSnapshot
    const started = foldActivity(initial, { type: 'turn/start', seq: SessionSeq(0), time: 150, data: { turn: 1 } }, 240)
    const summaries = new Map([[sessionId, started]])
    const statuses = new Map<SessionId, SessionStatus>([[sessionId, { running: true, completionUnread: false,
      pendingInteraction: new PendingApproval(sessionId, { toolName: 'read_file', reason: 'Allow this file' }),
    }]])
    const row = (ledger = read) => deriveRows(list, workspace, statuses, summaries, new Map(), ledger)[0]
    expect(row()).toMatchObject({ status: 'attention', priority: 0, preview: 'Allow this file', unread: false })
    statuses.set(sessionId, { running: true, completionUnread: false, pendingInteraction: undefined })
    expect(row()).toMatchObject({ status: 'running', priority: 2, unread: false })
    summaries.set(sessionId, foldActivity(started, finish(5), 240))
    statuses.set(sessionId, { running: false, completionUnread: false, pendingInteraction: undefined })
    expect(row()).toMatchObject({ status: 'completed', priority: 3, unread: true, readTargets: [{ sessionId, throughSeq: 5 }] })
    const acknowledged = { ...read, revision: 1, through: { [sessionId]: 5 } }
    expect(row(acknowledged)).toMatchObject({ status: 'completed', priority: 4, unread: false })
    summaries.set(sessionId, foldActivity(summaries.get(sessionId)!, { type: 'turn/start', seq: SessionSeq(6), time: 300, data: { turn: 2 } }, 240))
    statuses.set(sessionId, { running: true, completionUnread: false, pendingInteraction: undefined })
    expect(row(acknowledged)).toMatchObject({ status: 'running', priority: 2, unread: false, activityAt: 300 })
  })
  it('does not turn a recoverable tool error or user stop into an unread failure', () => {
    const sessionId = id('stop-and-rerun')
    const list: SessionListState = { phase: 'ready', ids: [sessionId], byId: {
      [sessionId]: { id: sessionId, displayTitle: 'Task', blank: false, running: false, retainedBy: {}, updatedAt: 150 },
    }, projectionsBySession: {} }
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [], pinnedSessionIds: [] } as WorkspaceSnapshot
    let summary = foldActivity(initial, { type: 'turn/start', seq: SessionSeq(0), time: 150, data: { turn: 1 } }, 240)
    const failedTool: SessionEvent<'tool/result'> = { type: 'tool/result', seq: SessionSeq(3), time: 175, surfaceOp: 'append', data: {
      turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('retryable'), isError: true, content: [{ type: 'text', text: 'Try again' }] }),
    } }
    const afterTool = foldActivity(summary, failedTool, 240)
    expect(afterTool).toBe(summary)
    const row = (running: boolean) => deriveRows(list, workspace, new Map([[sessionId, { running, completionUnread: false, pendingInteraction: undefined }]]),
      new Map([[sessionId, summary]]), new Map(), read)[0]
    expect(row(true)).toMatchObject({ status: 'running', priority: 2, unread: false })
    summary = foldActivity(summary, { ...finish(5), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } } }, 240)
    expect(row(false)).toMatchObject({ status: 'stopped', priority: 4, unread: false, readTargets: [] })
    summary = foldActivity(summary, { type: 'turn/start', seq: SessionSeq(6), time: 300, data: { turn: 2 } }, 240)
    expect(row(true)).toMatchObject({ status: 'running', priority: 2, unread: false })
    summary = foldActivity(summary, { ...finish(9), time: 400, data: { turn: 2, reason: { kind: 'completed' } } }, 240)
    expect(row(false)).toMatchObject({ status: 'completed', priority: 3, unread: true, readTargets: [{ sessionId, throughSeq: 9 }] })
  })
  it('orders attention, unread failure, running and completion before read history', () => {
    const list: SessionListState = { phase: 'ready', ids: ['read', 'done', 'running', 'failed', 'attention-old', 'attention-new'].map(id), byId: {}, projectionsBySession: {} }
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [], pinnedSessionIds: [] } as WorkspaceSnapshot
    const summaries = new Map<SessionId, ActivitySummary>(), statuses = new Map<SessionId, SessionStatus>()
    for (const [index, sessionId] of list.ids.entries()) {
      list.byId[sessionId] = { id: sessionId, displayTitle: sessionId, blank: false, running: false, retainedBy: {}, updatedAt: 150 }
      const activityAt = 700 - index * 50
      summaries.set(sessionId, { ...foldActivity(initial, finish(5), 240), activityAt,
        outcome: sessionId === 'failed' ? 'failed' : sessionId === 'running' ? 'running' : 'completed' })
      statuses.set(sessionId, { running: sessionId === 'running', completionUnread: false,
        pendingInteraction: sessionId.startsWith('attention') ? new PendingApproval(sessionId, { toolName: 'read_file' }) : undefined })
    }
    summaries.set(id('attention-new'), { ...summaries.get(id('attention-new'))!, activityAt: 550 })
    const rows = deriveRows(list, workspace, statuses, summaries, new Map(), { ...read, through: { read: 5 } })
    expect(rows.map(row => row.id)).toEqual(['attention-new', 'attention-old', 'failed', 'running', 'done', 'read'])
    expect(rows.map(row => row.priority)).toEqual([0, 0, 1, 2, 3, 4])
  })
  it('groups calendar dates across daylight-saving changes', () => {
    const now = new Date(2026, 10, 12, 1).getTime()
    expect(dateBucket(new Date(2026, 10, 12, 0).getTime(), now).kind).toBe('today')
    expect(dateBucket(new Date(2026, 10, 11, 23).getTime(), now).kind).toBe('yesterday')
    expect(dateBucket(new Date(2026, 10, 10).getTime(), now).kind).toBe('weekday')
    expect(dateBucket(new Date(2026, 10, 1).getTime(), now).kind).toBe('date')
  })
  it('aggregates child work, hides archived and empty rows, and ignores streaming timestamps', () => {
    const list: SessionListState = { phase: 'ready', ids: ['parent', 'child', 'done', 'hidden', 'empty'].map(id), byId: {}, projectionsBySession: {} }
    for (const key of list.ids) list.byId[key] = { id: key, displayTitle: key, running: key === 'child', retainedBy: {}, blank: key === 'empty', updatedAt: 150 }
    list.byId[id('child')]!.origin = 'subagent'; list.byId[id('child')]!.parentId = id('parent')
    const workspace: WorkspaceSnapshot = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [id('hidden')], pinnedSessionIds: [] }
    const summaries = new Map([[id('done'), foldActivity(initial, finish(6), 240)]])
    const rows = deriveRows(list, workspace, new Map(), summaries, new Map([[id('child'), '最新进展']]), read)
    expect(rows.map(row => row.id)).toEqual(['parent', 'done'])
    expect(rows[0]).toMatchObject({ target: 'child', status: 'running', childrenRunning: 1, preview: '最新进展', activityAt: 150 })
    expect(rows[1]).toMatchObject({ priority: 3, unread: true })
    expect(deriveRows(list, workspace, new Map(), summaries, new Map([[id('child'), '更多进展']]), read).map(row => row.id)).toEqual(['parent', 'done'])
  })
  it('only aggregates descendants whose full chain reaches an unarchived ordinary catalog row', () => {
    const list: SessionListState = { phase: 'ready', ids: ['parent', 'archived', 'orphan', 'cycle-a', 'self', 'no-parent'].map(id), byId: {}, projectionsBySession: {} }
    const add = (key: string, parent?: string, subagent = parent !== undefined) => {
      list.byId[id(key)] = { id: id(key), displayTitle: key, running: subagent, retainedBy: {}, blank: false, updatedAt: 150,
        ...(subagent ? { origin: 'subagent' as const } : {}), ...(parent ? { parentId: id(parent) } : {}) }
    }
    add('parent'); add('archived'); add('retained-only')
    add('child', 'parent'); add('grandchild', 'child')
    add('archived-child', 'archived'); add('archived-grandchild', 'archived-child')
    add('archived-middle', 'parent'); add('under-archived-middle', 'archived-middle')
    add('orphan', 'missing'); add('under-orphan', 'orphan')
    add('cycle-a', 'cycle-b'); add('cycle-b', 'cycle-a'); add('self', 'self')
    add('no-parent', undefined, true); add('uncatalogued-child', 'retained-only')
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: ['archived', 'archived-middle'].map(id), pinnedSessionIds: [] } as WorkspaceSnapshot
    const rows = deriveRows(list, workspace, new Map(), new Map(), new Map(), read)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'parent', childrenRunning: 2, status: 'running' })
  })
  it('localizes approval presentation copy and retains reason/tool fallbacks', () => {
    const sessionId = id('approval')
    const list: SessionListState = { phase: 'ready', ids: [sessionId], byId: {
      [sessionId]: { id: sessionId, displayTitle: '审批', running: true, retainedBy: {}, blank: false, updatedAt: 150 },
    }, projectionsBySession: {} }
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [], pinnedSessionIds: [] } as WorkspaceSnapshot
    const approval = new PendingApproval(sessionId, { toolName: 'read_file', reason: 'AUDIT_POLICY_REQUIRED', displayReason: { en: 'Approve file access', zh: '允许读取文件' } })
    const statuses = new Map([[sessionId, { running: true, completionUnread: false, pendingInteraction: approval }]])
    expect(deriveRows(list, workspace, statuses, new Map(), new Map(), read, new Set(), reason => reason.zh ?? reason.en)[0]?.preview).toBe('允许读取文件')
    expect(deriveRows(list, workspace, statuses, new Map(), new Map(), read)[0]?.preview).toBe('AUDIT_POLICY_REQUIRED')
    statuses.set(sessionId, { running: true, completionUnread: false, pendingInteraction: new PendingApproval(sessionId, { toolName: 'read_file' }) })
    expect(deriveRows(list, workspace, statuses, new Map(), new Map(), read)[0]?.preview).toBe('read_file')
  })
})
