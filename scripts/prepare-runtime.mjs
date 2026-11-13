/** Install the official pinned DSH into an owned validation directory, never a source checkout. */
import { readFile, writeFile, mkdir, readdir, access, mkdtemp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const required = JSON.parse(await readFile(join(root, 'packages/activity/compatibility.json'), 'utf8')).dshVersion
let directory = process.argv[2] ?? process.env.BETTER_ACTIVITY_TEST_RUNTIME
if (!directory) {
  try { directory = JSON.parse(await readFile(join(root, '.dev/runtime.json'), 'utf8')).path }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
directory = directory ? resolve(directory) : await mkdtemp(join(tmpdir(), 'better-activity-runtime-'))
await mkdir(directory, { recursive: true })
let manifest
try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (manifest) {
  if (!manifest.private || manifest.name !== 'better-activity-stock-runtime') throw new Error('The runtime directory belongs to another project')
} else {
  if ((await readdir(directory)).length) throw new Error('Use an empty directory for the stock runtime')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'better-activity-stock-runtime', private: true }, null, 2) + '\n')
}
let installed
try { installed = JSON.parse(await readFile(join(directory, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (installed !== required) {
  let npmCli
  for (const candidate of [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]) {
    try { await access(candidate); npmCli = candidate; break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!npmCli) throw new Error('Use a Node.js installation that includes npm')
  const result = spawnSync(process.execPath, [npmCli, 'install', `@deepseek-ai/dsh@${required}`, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: directory, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
await mkdir(join(root, '.dev'), { recursive: true })
await writeFile(join(root, '.dev/runtime.json'), JSON.stringify({ path: directory, version: required }, null, 2) + '\n')
console.log('Official DSH validation runtime: ' + directory)
