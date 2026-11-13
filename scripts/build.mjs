/** Build strict Remote metadata and both plugin faces against the selected DSH checkout. */
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'
import { build } from 'tsdown'

const root = resolve(import.meta.dirname, '..')
const packageRoot = join(root, 'packages/activity')
const { path: dsh } = JSON.parse(await readFile(join(root, '.dev/dsh.json'), 'utf8'))
function tsc(config) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', config, '--pretty', 'false'], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
tsc('packages/activity/tsconfig.host.json')
const artifacts = new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generateContributors(['host'])
if (!artifacts.some(item => item.remote)) throw new Error('No strict Remote metadata generated')
writePackageArtifacts(packageRoot, artifacts)
if (process.argv.includes('--host-only')) process.exit(0)
tsc('packages/activity/tsconfig.client.json')
const { clientBundle } = await import(pathToFileURL(join(dsh, 'packages/client/tsdown.client.ts')).href)
process.chdir(packageRoot)
const configs = clientBundle(packageRoot, ['lib/types/index.js', 'lib/types/types.js'])({ env: {} })
for (const config of configs) await build({ ...config, config: false })
console.log('BetterActivity built against ' + dsh)
