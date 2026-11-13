/** An actual process loss and cold read using the unpatched npm Host. */
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { resolveRuntime } from '../scripts/runtime.ts'
import type { ActivityReadState, ActivitySummary } from '../packages/activity/src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isUnread } from '../packages/activity/src/client/model.ts'

interface RecoveryReport {
  ok: boolean
  error?: string
  checks: string[]
  sessionId: string
  summary: ActivitySummary
  read: ActivityReadState
  eventHash: string
  tip?: number
}

it('recovers an unfinished durable turn after process loss without clearing unread state or rewriting the log', async () => {
  const root = resolve(import.meta.dirname, '..')
  const runtime = await resolveRuntime(root)
  if (!runtime.stock) throw new Error('Recovery verification requires the official npm runtime, not a source checkout')
  const directory = join(root, '.dev/full-verification-0.2.0')
  await mkdir(directory, { recursive: true })
  const temp = await mkdtemp(join(directory, 'recovery-'))
  const env = { ...process.env, DSH_HOME: join(temp, 'home'), DSH_TELEMETRY_DISABLED: '1' }
  const version: string = JSON.parse(await readFile(join(root, 'packages/activity/package.json'), 'utf8')).version
  const archive = process.env.BETTER_ACTIVITY_TEST_TARBALL ?? join(root, 'dist', `dsh-better-activity-${version}.tgz`)
  const redact = (value: string): string => value.replace(/token=\S+/g, 'token=[redacted]')
  function cli(args: string[]): void {
    const result = spawnSync(process.execPath, [...runtime.args, ...args], { cwd: runtime.cwd, env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (result.status !== 0) throw new Error(redact(result.stdout + result.stderr) || String(result.error))
  }
  cli(['--profile', 'web', '--dump-config'])
  cli(['plugin', '--profile', 'web', 'add', archive])
  const installed = join(env.DSH_HOME, 'profiles/web/node_modules/dsh-better-activity')
  expect(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version).toBe(version)
  expect(await readFile(join(installed, 'lib/index.js'), 'utf8')).toBe(await readFile(join(root, 'packages/activity/lib/index.js'), 'utf8'))
  async function boot(stage: 'seed' | 'recover'): Promise<RecoveryReport> {
    const report = join(temp, stage + '.json'), overlay = join(temp, stage + '.patch.yml')
    await writeFile(overlay, JSON.stringify([
      { id: 'workspace-controller', config: { documentsDirectory: join(temp, 'projects') } },
      { insert: [{ id: 'activity-recovery-fixture', name: join(root, 'tests/fixtures/recovery.mjs'),
        config: { stage, root: join(temp, 'projects'), report, runtimeDirectory: runtime.cwd } }] },
    ]))
    const child = spawn(process.execPath, [...runtime.args, '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0'], {
      cwd: runtime.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
    const exited = once(child, 'exit')
    try {
      const deadline = Date.now() + 60_000
      while (true) {
        try { await access(report); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Recovery ${stage} did not finish: ` + redact(output))
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const value = JSON.parse(await readFile(report, 'utf8')) as RecoveryReport
      expect(value, value.error).toMatchObject({ ok: true })
      return value
    } finally {
      // The first Host must not gracefully seal the deliberately unfinished turn.
      if (child.exitCode === null) child.kill(stage === 'seed' ? 'SIGKILL' : 'SIGTERM')
      await exited
      await writeFile(join(temp, stage + '-host.log'), redact(output))
    }
  }
  const before = await boot('seed')
  const after = await boot('recover')
  expect(before.summary.outcome).toBe('running')
  expect(after.summary.outcome).toBe('interrupted')
  expect(after.summary.terminalSeq).toBeGreaterThan(before.tip!)
  expect(after.summary.preview).toBe(before.summary.preview)
  expect(isUnread(after.summary, after.sessionId as SessionId, after.read)).toBe(true)
  expect(after.read).toEqual(before.read)
  expect(after.eventHash).toBe(before.eventHash)
  await writeFile(join(temp, 'verification.json'), JSON.stringify({ runtime, archive, before, after }, null, 2))
  console.info(`BetterActivity official-runtime recovery verification: ${temp}`)
}, 180_000)
