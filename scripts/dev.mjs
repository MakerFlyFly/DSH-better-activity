/** Start the real DSH application with a separate home and this local bundle. */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { resolveRuntime } from './runtime.ts'

const root = resolve(import.meta.dirname, '..')
const runtime = await resolveRuntime(root)
const dsh = runtime.cwd
const previewRoot = process.env.BETTER_ACTIVITY_PREVIEW_ROOT ? resolve(process.env.BETTER_ACTIVITY_PREVIEW_ROOT) : join(root, '.dev')
const home = join(previewRoot, 'home')
await mkdir(home, { recursive: true })
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
const launcher = runtime.args
function run(args, quiet = false) {
  const result = spawnSync(process.execPath, [...launcher, ...args], { cwd: dsh, env, stdio: quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const manifest = join(home, 'profiles/web/package.json')
if (!existsSync(manifest)) run(['--profile', 'web', '--dump-config'], true)
const profile = JSON.parse(await readFile(manifest, 'utf8'))
const installed = profile.dependencies?.['dsh-better-activity']
const plugin = JSON.parse(await readFile(join(root, 'packages/activity/package.json'), 'utf8'))
const packagePath = join(root, 'dist', `${plugin.name}-${plugin.version}.tgz`)
const packageSpec = 'file:' + packagePath.replaceAll('\\', '/')
if (!existsSync(packagePath)) throw new Error('Build and package BetterActivity before starting the isolated preview')
if (installed !== packageSpec) {
  if (installed) run(['plugin', '--profile', 'web', 'remove', 'dsh-better-activity'])
  run(['plugin', '--profile', 'web', 'add', packagePath])
}
if (process.argv.includes('--install-only')) process.exit(0)
const port = process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? '3082'
const overlay = join(previewRoot, 'development.patch.yml')
const rows = [
  { id: 'workspace-controller', config: { documentsDirectory: join(previewRoot, 'projects') } },
  { id: 'directory-picker', disabled: true },
  { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }, { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] },
]
if (process.argv.includes('--fixture')) rows.push({ insert: [{ id: 'activity-fixture', name: join(root, 'tests/fixtures/seed.ts'), config: { live: process.argv.includes('--live'), summaryCases: true, runtimeDirectory: dsh, root: join(previewRoot, 'projects'), report: join(previewRoot, 'fixture-report.json') } }] })
await writeFile(overlay, JSON.stringify(rows))
const child = spawn(process.execPath, [...launcher, '--profile', 'web', '--patch', overlay, '--no-open', '--port', port], { cwd: dsh, env, stdio: 'inherit', windowsHide: true })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
