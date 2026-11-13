/** Bounded deterministic projection of public assistant text and turn outcomes. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ActivitySummary } from '../types.ts'

export const summarySchema = z.object({
  seq: z.number().int().min(-1), activityAt: z.number(), preview: z.string(),
  outcome: z.enum(['idle', 'running', 'completed', 'failed', 'stopped', 'interrupted']),
  terminalSeq: z.number().int().min(-1), terminalAt: z.number(), engaged: z.boolean(),
})

/** @param text - Public message text. @param limit - Code-point budget. @returns Plain bounded preview. */
export function previewText(text: string, limit: number): string {
  const protectedText: string[] = []
  const protect = (value: string): string => `\0${protectedText.push(value) - 1}\0`
  const parts: string[] = []
  let cursor = 0
  const openings = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm
  for (let opening = openings.exec(text); opening; opening = openings.exec(text)) {
    const fence = opening[1]!
    // A backtick in the info string makes this ordinary text, possibly an inline code span.
    if (fence[0] === '`' && opening[2]!.includes('`')) continue
    const bodyStart = openings.lastIndex
    const closingPattern = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm')
    closingPattern.lastIndex = bodyStart
    const closing = closingPattern.exec(text)
    parts.push(protectInlineCode(text.slice(cursor, opening.index), protect), '\n',
      protect(text.slice(bodyStart, closing?.index ?? text.length)), '\n')
    cursor = closing ? closingPattern.lastIndex : text.length
    openings.lastIndex = cursor
  }
  parts.push(protectInlineCode(text.slice(cursor), protect))
  // Clean the complete prose so emphasis and links can contain protected code.
  const plain = parts.join('')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n) {0,3}(?:#{1,6}\s+|>\s?)/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])(\*{1,3}|_{1,3}|~~)(?=\S)([^\n]*?\S)\2(?=$|[^\p{L}\p{N}_])/gu, '$1$3')
    .replace(/\0(\d+)\0/g, (_match, index: string) => protectedText[Number(index)]!)
    .replace(/\s+/g, ' ').trim()
  return Array.from(plain).slice(0, limit).join('')
}

/** Protect matched inline spans and literal placeholder delimiters within one prose region. */
function protectInlineCode(text: string, protect: (value: string) => string): string {
  const runs = [...text.matchAll(/`+/g)]
  const next = new Map<number, number>()
  const closing: (number | undefined)[] = new Array(runs.length)
  for (let index = runs.length - 1; index >= 0; index--) {
    const length = runs[index]![0].length
    closing[index] = next.get(length); next.set(length, index)
  }
  // Source NULs are opaque too, so restoring a slot cannot reinterpret user text as another slot.
  const prose = (value: string): string => value.replace(/\0/g, () => protect('\0'))
  const parts: string[] = []
  let cursor = 0
  for (let index = 0; index < runs.length; index++) {
    const opening = runs[index]!
    let escapeStart = opening.index
    while (escapeStart > 0 && text[escapeStart - 1] === '\\') escapeStart--
    const endIndex = closing[index]
    if ((opening.index - escapeStart) % 2 !== 0 || endIndex === undefined) continue
    const end = runs[endIndex]!
    parts.push(prose(text.slice(cursor, opening.index)), protect(text.slice(opening.index + opening[0].length, end.index)))
    cursor = end.index + end[0].length; index = endIndex
  }
  parts.push(prose(text.slice(cursor)))
  return parts.join('')
}

/** @param limit - Configured preview budget. @returns The plugin's recovery definition. */
export function activityProjection(limit: number) {
  return {
    key: 'betterActivity', stateVersion: 3_000_000 + limit, stateSchema: summarySchema,
    init: header => ({ seq: -1, activityAt: header.createdAt, preview: '', outcome: 'idle', terminalSeq: -1, terminalAt: 0, engaged: false }),
    apply: (state, event) => foldActivity(state, event, limit),
    wire: { viewSchema: summarySchema, view: state => state },
  } satisfies ProjectionDefinition<'betterActivity', ActivitySummary>
}

/** @param state - Prior summary. @param event - Committed logical event. @param limit - Preview budget. @returns Updated summary. */
export function foldActivity(state: ActivitySummary, event: SessionEvent, limit: number): ActivitySummary {
  const moved = { seq: event.seq, activityAt: event.time }
  switch (event.type) {
    case 'turn/start': return { ...state, ...moved, outcome: 'running' }
    case 'user/message': return event.data.source.kind === 'user' ? { ...state, ...moved, engaged: true } : state
    case 'assistant/message': {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(' ')
      const preview = previewText(text, limit)
      return preview === '' ? state : { ...state, ...moved, preview, engaged: true }
    }
    case 'turn/end': {
      const reason = event.data.reason.kind
      const outcome = reason === 'completed' ? 'completed' : reason === 'aborted' || reason === 'forked' ? 'stopped'
        : reason === 'interrupted' ? 'interrupted' : 'failed'
      return { ...state, ...moved, outcome, terminalSeq: event.seq, terminalAt: event.time }
    }
    default: return state
  }
}
