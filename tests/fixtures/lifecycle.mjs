/** Real profile enablement probe; this fixture survives the activity bundle's unload. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

export const inject = ['appReady', 'pluginManager']

export function apply(ctx, config) {
  let pending = Promise.resolve()
  ctx.effect(() => ctx.appReady.onReady(() => {
    pending = verify(ctx, config).catch(async error => {
      await writeFile(config.report, JSON.stringify({ ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2))
    })
  }), 'activity lifecycle probe: application readiness')
  ctx.effect(() => () => pending, 'activity lifecycle probe: completion')
}

async function verify(ctx, config) {
  const persistedRead = async () => JSON.parse(await readFile(config.ledgerPath, 'utf8')).tables.read.owner
  const checks = []
  assert.deepEqual(await persistedRead(), config.expectedRead)
  if (config.mode === 'absent') {
    assert.equal(ctx.get('betterActivity'), undefined)
    checks.push('uninstalled bundle has no active service and retains the read ledger')
  } else {
    const before = ctx.get('betterActivity')
    assert.ok(before)
    assert.deepEqual((await before.snapshot()).read, config.expectedRead)
    const disabled = await ctx.pluginManager.setBundleEnabled('dsh-better-activity', false)
    assert.equal(disabled.application, 'applied', JSON.stringify(disabled))
    assert.equal(ctx.get('betterActivity'), undefined)
    assert.deepEqual(await persistedRead(), config.expectedRead)
    checks.push('native bundle disable releases the activity service and retains the read ledger')
    const enabled = await ctx.pluginManager.setBundleEnabled('dsh-better-activity', true)
    assert.equal(enabled.application, 'applied', JSON.stringify(enabled))
    const after = ctx.get('betterActivity')
    assert.ok(after)
    assert.notEqual(after, before)
    assert.deepEqual((await after.snapshot()).read, config.expectedRead)
    checks.push('native bundle enable creates a fresh activity service with the same read ledger')
  }
  await writeFile(config.report, JSON.stringify({ ok: true, checks, read: await persistedRead() }, null, 2))
}
