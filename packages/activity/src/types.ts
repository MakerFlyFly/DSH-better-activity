/** Public activity values carried by projections and the generated Remote API. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Latest durable public activity of one conversation. */
export interface ActivitySummary {
  seq: number
  activityAt: number
  preview: string
  outcome: 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  terminalSeq: number
  terminalAt: number
  engaged: boolean
}
/** Persisted acknowledgement watermarks; absent entries use installedAt. */
export interface ActivityReadState {
  version: 1
  installedAt: number
  revision: number
  through: Record<string, number>
}
/** A bounded public-text preview of the current live attempt. */
export interface LivePreview { sessionId: SessionId; text: string }
/** One projected conversation. */
export interface ActivityEntry { sessionId: SessionId; summary: ActivitySummary }
/** Baselines replace client state; updates replace only the named entries. */
export interface ActivityFrame {
  reset: boolean
  revision: number
  read: ActivityReadState
  entries: ActivityEntry[]
  previews: LivePreview[]
  failures: SessionId[]
  hydrateBatchSize: number
}
/** Acknowledges only the event version the user actually saw. */
export interface ReadAcknowledgement { sessionId: SessionId; throughSeq: number }
/** Bounded request for historical activity summaries. */
export interface HydrationRequest { sessionIds: SessionId[] }
/** Mutation outcome; failures leave the durable ledger unchanged. */
export type MarkReadResult = { ok: true } | { ok: false; code: 'invalid-request' | 'unavailable' }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { betterActivity: ActivitySummary }
}
