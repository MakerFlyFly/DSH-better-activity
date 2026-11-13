/** Pure activity rows and calendar grouping over authoritative Client snapshots. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ActivityReadState, ActivitySummary, ReadAcknowledgement } from '../types.ts'

export type ActivityStatus = 'attention' | 'failed' | 'running' | 'completed' | 'stopped' | 'interrupted' | 'idle' | 'unavailable'
export interface ActivityRow {
  id: SessionId; target: SessionId; title: string; project: string; preview: string
  status: ActivityStatus; priority: number; unread: boolean; current: boolean
  activityAt: number; childrenRunning: number; readTargets: ReadAcknowledgement[]
}
export interface ActivityData {
  phase: 'loading' | 'ready' | 'offline' | 'error'
  rows: readonly ActivityRow[]
  moreLoading: boolean
  mutationError: boolean
  summaryError: boolean
  catalogError: boolean
}

/** @param summary - Durable terminal state. @param id - Conversation identity. @param read - Committed read ledger. @returns Unacknowledged outcome. */
export function isUnread(summary: ActivitySummary | undefined, id: SessionId, read: ActivityReadState | null): boolean {
  return summary !== undefined && read !== null && summary.terminalSeq >= 0 && summary.terminalAt >= read.installedAt
    && (summary.outcome === 'completed' || summary.outcome === 'failed' || summary.outcome === 'interrupted')
    && (Object.hasOwn(read.through, id) ? read.through[id]! : -1) < summary.terminalSeq
}

/** @returns One top-level row per ordinary conversation, aggregating subagent attention. */
export function deriveRows(list: SessionListState, workspaces: WorkspaceSnapshot, statuses: SessionStatusSnapshot,
  summaries: ReadonlyMap<SessionId, ActivitySummary>, previews: ReadonlyMap<SessionId, string>, read: ActivityReadState | null, failures: ReadonlySet<SessionId> = new Set(),
  resolveReason?: (reason: NonNullable<PendingApproval['displayReason']>) => string): ActivityRow[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const projectNames = new Map<SessionId, string>()
  for (const project of workspaces.items) {
    const name = project.title.trim() || project.path.split(/[\\/]/).filter(Boolean).at(-1) || ''
    for (const id of project.sessionIds) if (!projectNames.has(id)) projectNames.set(id, name)
  }
  const members = new Map<SessionId, SessionId[]>()
  // Only ordinary catalog entries own rows; an invalid ancestor chain never promotes a child.
  for (const id of list.ids) {
    const item = list.byId[id]
    if (item && item.origin !== 'subagent' && !archived.has(id)) members.set(id, [id])
  }
  for (const item of Object.values(list.byId)) {
    if (item.origin !== 'subagent') continue
    let ancestor: SessionId | undefined = item.id
    const visited = new Set<SessionId>()
    while (ancestor && !members.has(ancestor) && !visited.has(ancestor) && !archived.has(ancestor)) {
      visited.add(ancestor)
      const parent: typeof item | undefined = list.byId[ancestor]
      ancestor = parent?.origin === 'subagent' ? parent.parentId : undefined
    }
    if (ancestor) members.get(ancestor)?.push(item.id)
  }
  const rows: ActivityRow[] = []
  for (const [root, ids] of members) {
    const item = list.byId[root]!
    if (item.blank && !ids.some(id => list.byId[id]?.running)) continue
    const row: ActivityRow = { id: root, target: root, title: item.title?.trim() || item.displayTitle, project: projectNames.get(root) ?? '',
      preview: '', status: 'idle', priority: 4, unread: false, current: ids.some(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0), activityAt: 0, childrenRunning: 0, readTargets: [] }
    let chosen = false
    for (const id of [root, ...ids.filter(id => id !== root)]) {
      const native = list.byId[id]
      if (!native) continue
      const cached = native.projectionValues?.betterActivity
      const loaded = summaries.get(id)
      const summary = loaded && (!cached || loaded.seq >= cached.seq) ? loaded : cached
      const status = statuses.get(id)
      const pending = status?.pendingInteraction
      const running = status?.running ?? native.running
      const unread = isUnread(summary, id, read)
      const interrupted = summary?.outcome === 'running' && !running
      const failed = summary?.outcome === 'failed' || summary?.outcome === 'interrupted' || interrupted
      const priority = pending ? 0 : unread && failed ? 1 : running ? 2 : unread ? 3 : 4
      const at = summary?.activityAt ?? native.updatedAt
      const candidateStatus: ActivityStatus = pending ? 'attention' : running ? 'running' : interrupted ? 'interrupted' : summary?.outcome ?? (failures.has(id) ? 'unavailable' : 'idle')
      row.activityAt = Math.max(row.activityAt, at)
      row.unread ||= unread
      if (running && id !== root) row.childrenRunning++
      if (unread && summary) row.readTargets.push({ sessionId: id, throughSeq: summary.terminalSeq })
      if (!chosen || priority < row.priority) {
        chosen = true; row.target = id; row.priority = priority; row.status = candidateStatus
        const pendingText = pending?.kind === 'approval' ? (pending.displayReason && resolveReason?.(pending.displayReason)) || pending.reason || pending.toolName
          : pending && 'questions' in pending ? pending.questions.map(question => question.question).join(' · ') : ''
        row.preview = pendingText || previews.get(id) || summary?.preview || ''
      }
    }
    rows.push(row)
  }
  return rows.sort((a, b) => a.priority - b.priority || b.activityAt - a.activityAt || a.id.localeCompare(b.id))
}

/** @param time - Activity timestamp. @param now - Client wall clock. @returns Local calendar grouping independent of DST day length. */
export function dateBucket(time: number, now: number): { key: string; kind: 'today' | 'yesterday' | 'weekday' | 'date'; date: Date } {
  const date = new Date(time), current = new Date(now)
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const today = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate())
  const delta = Math.floor((today - day) / 86_400_000)
  return { key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`, kind: delta <= 0 ? 'today' : delta === 1 ? 'yesterday' : delta < 7 ? 'weekday' : 'date', date }
}
