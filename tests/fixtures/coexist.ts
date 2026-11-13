/** Composition barrier for the optional two-plugin installation test. */
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
export const inject = ['betterActivity', 'betterClassifier']
export async function apply(ctx: Context, config: { report: string }): Promise<void> {
  await writeFile(config.report, JSON.stringify({ ok: Boolean(ctx.get('betterActivity') && ctx.get('betterClassifier')) }))
}
