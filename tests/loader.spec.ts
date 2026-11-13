/** Real pinned CLI, profile, Loader and durable activity state integration. */
import { mkdir, mkdtemp, readFile, writeFile, access, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import type { ActivityReadState, ActivitySummary } from '../packages/activity/src/types.ts'
import { resolveRuntime } from '../scripts/runtime.ts'
import { summaryCases } from './fixtures/summary-cases.ts'

interface ProbeReport { ok: boolean; error?: string; checks: string[] }
interface FixtureReport extends ProbeReport {
  summaryResults: { id: string; sessionId: string; summary: ActivitySummary; projectionVersion: number }[]
  initialRead: ActivityReadState
  readBeforeHydration: ActivityReadState
  readAfterHydration: ActivityReadState
  finalRead: ActivityReadState
}
interface CachedSummary { ver: number; seq: number; val: ActivitySummary }

it('retains activity data across restart, enablement, reinstall and an optional 0.1.3 upgrade on the selected real runtime', async () => {
  const root = resolve(import.meta.dirname, '..')
  const runtime = await resolveRuntime(root)
  const lane = runtime.stock ? 'stock' : 'source-coexistence'
  const classifier = process.env.BETTER_ACTIVITY_TEST_CLASSIFIER
  if (classifier && runtime.stock) throw new Error('BetterClassifier coexistence requires explicit BETTER_ACTIVITY_TEST_SOURCE_DSH; it cannot attest stock-runtime compatibility')
  await mkdir(join(root, '.dev/loader-tests'), { recursive: true })
  const temp = await mkdtemp(join(root, `.dev/loader-tests/${lane}-`))
  const env = { ...process.env, DSH_HOME: join(temp, 'home') }
  const currentVersion: string = JSON.parse(await readFile(join(root, 'packages/activity/package.json'), 'utf8')).version
  const packageSpec = process.env.BETTER_ACTIVITY_TEST_TARBALL ?? join(root, 'dist', `dsh-better-activity-${currentVersion}.tgz`)
  const previousPackage = process.env.BETTER_ACTIVITY_TEST_PREVIOUS_TARBALL
  const commands: { args: string[]; exitCode: number | null }[] = []
  const evidence: { stage: string; checks: string[] }[] = []
  const redact = (text: string): string => text.replace(/token=\S+/g, 'token=[redacted]')
  function cli(args: string[]): void {
    const child = spawnSync(process.execPath, [...runtime.args, ...args], { cwd: runtime.cwd, env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    commands.push({ args, exitCode: child.status })
    if (child.status !== 0) throw new Error(redact(child.stdout + child.stderr) || String(child.error))
  }
  cli(['--profile', 'web', '--dump-config'])
  cli(['plugin', '--profile', 'web', 'add', previousPackage ?? packageSpec])
  if (classifier) cli(['plugin', '--profile', 'web', 'add', classifier])
  async function verifyInstalledBuild(previous = false): Promise<void> {
    const installed = await realpath(join(env.DSH_HOME, 'profiles/web/node_modules/dsh-better-activity'))
    expect(installed).not.toBe(await realpath(join(root, 'packages/activity')))
    const installedVersion = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version
    if (previous) { expect(installedVersion).toBe('0.1.3'); return }
    expect(installedVersion).toBe(currentVersion)
    expect(await readFile(join(installed, 'lib/client.js'), 'utf8')).toBe(await readFile(join(root, 'packages/activity/lib/client.js'), 'utf8'))
    expect(await readFile(join(installed, 'lib/index.js'), 'utf8')).toBe(await readFile(join(root, 'packages/activity/lib/index.js'), 'utf8'))
  }
  await verifyInstalledBuild(previousPackage !== undefined)
  const ledgerPath = join(env.DSH_HOME, 'storages/better_activity.json')
  const persistedRead = async (): Promise<ActivityReadState> => JSON.parse(await readFile(ledgerPath, 'utf8')).tables.read.owner
  async function waitForCachedSummary(sessionId: string, summary: ActivitySummary): Promise<CachedSummary> {
    const path = join(env.DSH_HOME, 'storages/session_projcache/sessions', sessionId + '.json')
    const deadline = Date.now() + 10_000
    let cached: CachedSummary | undefined
    while (Date.now() < deadline) {
      try { cached = JSON.parse(await readFile(path, 'utf8')).record.rows.betterActivity }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (cached?.ver === 3_000_240 && cached.val.preview === summary.preview) {
        expect(cached.val).toEqual(summary)
        return cached
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Expected unchanged activity cache 3000240 for ${sessionId}, received ${JSON.stringify(cached)}`)
  }
  async function boot<T extends ProbeReport>(stage: string, fixture: string, config: Record<string, unknown>, withClassifier = false, beforeStop?: (report: T) => Promise<void>): Promise<T> {
    const report = join(temp, `${stage}-report.json`)
    const coexistReport = join(temp, `${stage}-coexist.json`)
    const overlay = join(temp, `${stage}.patch.yml`)
    await writeFile(overlay, JSON.stringify([
      { id: 'workspace-controller', config: { documentsDirectory: join(temp, 'projects') } },
      { insert: [
        { id: 'activity-fixture', name: join(root, 'tests/fixtures', fixture), config: { root: join(temp, 'projects'), runtimeDirectory: runtime.cwd, ...config, report } },
        ...withClassifier ? [{ id: 'activity-coexist', name: join(root, 'tests/fixtures/coexist.ts'), config: { report: coexistReport } }] : [],
      ] },
    ]))
    const child = spawn(process.execPath, [...runtime.args, '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], { cwd: runtime.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let log = ''
    child.stdout.on('data', chunk => { log += String(chunk) }); child.stderr.on('data', chunk => { log += String(chunk) })
    const exited = once(child, 'exit')
    try {
      const deadline = Date.now() + 60_000
      while (true) {
        try { await access(report); if (withClassifier) await access(coexistReport); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture ${stage} did not finish: ` + redact(log))
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const result = JSON.parse(await readFile(report, 'utf8')) as T
      expect(result, result.error).toMatchObject({ ok: true })
      if (withClassifier) expect(JSON.parse(await readFile(coexistReport, 'utf8'))).toEqual({ ok: true })
      await beforeStop?.(result)
      evidence.push({ stage, checks: result.checks })
      return result
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      await exited
      await writeFile(join(temp, `${stage}-host.log`), redact(log))
    }
  }
  const persistedCaches: { id: string; sessionId: string; cache: CachedSummary }[] = []
  const first = await boot<FixtureReport>('initial', 'seed.ts', { verify: true, summaryCases: true }, Boolean(classifier), async result => {
    expect(result.summaryResults.map(item => item.id)).toEqual(summaryCases.map(sample => sample.id))
    for (const sample of summaryCases) {
      const item = result.summaryResults.find(value => value.id === sample.id)!
      expect(item.summary.preview).toBe(sample.preview)
      expect(item.projectionVersion).toBe(3_000_240)
      persistedCaches.push({ id: sample.id, sessionId: item.sessionId, cache: await waitForCachedSummary(item.sessionId, item.summary) })
    }
  })
  expect(first.checks).toContain('concurrent acknowledgements never move the watermark backwards')
  expect(first.checks).toContain('future acknowledgement is rejected without changing read state')
  const checkUnchanged = (result: FixtureReport): void => {
    expect(result.checks).toContain('read acknowledgement survives real Host restart')
    expect(result.checks).toContain('summary hydration does not write read state')
    expect(result.checks).toContain('future acknowledgement is rejected without changing read state')
    expect(result.summaryResults).toEqual(first.summaryResults)
    for (const read of [result.initialRead, result.readBeforeHydration, result.readAfterHydration, result.finalRead]) expect(read).toEqual(first.finalRead)
  }
  if (previousPackage) {
    cli(['plugin', '--profile', 'web', 'remove', 'dsh-better-activity'])
    expect(await persistedRead()).toEqual(first.finalRead)
    cli(['plugin', '--profile', 'web', 'add', packageSpec])
    await verifyInstalledBuild()
  }
  const next = await boot<FixtureReport>(previousPackage ? 'upgrade' : 'restart', 'seed.ts', { verify: true, summaryCases: true, preserveRead: true }, Boolean(classifier))
  checkUnchanged(next)
  if (previousPackage) await writeFile(join(temp, 'upgrade-verification.json'), JSON.stringify({
    lane, runtime, previousVersion: '0.1.3', currentVersion, read: next.finalRead, persistedCaches, recoveredSummaries: next.summaryResults,
    checks: ['projection version remains 3000240', 'every summary field is unchanged', 'installedAt, read revision and every watermark unchanged'],
  }, null, 2))
  const lifecycle = await boot<ProbeReport & { read: ActivityReadState }>('enablement', 'lifecycle.mjs', { ledgerPath, expectedRead: first.finalRead })
  expect(lifecycle.read).toEqual(first.finalRead)
  cli(['plugin', '--profile', 'web', 'remove', 'dsh-better-activity'])
  expect(await persistedRead()).toEqual(first.finalRead)
  const removed = JSON.parse(await readFile(join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'))
  expect(removed.dependencies?.['dsh-better-activity']).toBeUndefined()
  expect(removed.dsh.profile.bundles).not.toContain('dsh-better-activity')
  const absent = await boot<ProbeReport & { read: ActivityReadState }>('uninstalled', 'lifecycle.mjs', { mode: 'absent', ledgerPath, expectedRead: first.finalRead })
  expect(absent.read).toEqual(first.finalRead)
  cli(['plugin', '--profile', 'web', 'add', packageSpec])
  await verifyInstalledBuild()
  const reinstalled = await boot<FixtureReport>('reinstalled', 'seed.ts', { verify: true, summaryCases: true, preserveRead: true }, Boolean(classifier))
  checkUnchanged(reinstalled)
  await writeFile(join(temp, 'loader-verification.json'), JSON.stringify({ lane, runtime, currentVersion, previousVersion: previousPackage ? '0.1.3' : null,
    classifier: classifier ?? null, commands, stages: evidence, read: reinstalled.finalRead, summaries: reinstalled.summaryResults,
    checks: ['installed Host and Client bytes match the release build', 'native disable and enable preserve read state', 'CLI remove and add preserve every read and summary field'],
  }, null, 2))
  console.info(`BetterActivity ${lane} Loader verification: ${temp}`)
}, 300_000)
