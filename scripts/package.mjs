/** Package prebuilt plugin code and source without host-modification scripts. */
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'

const root = resolve(import.meta.dirname, '..')
const { path: dsh } = JSON.parse(await readFile(join(root, '.dev/dsh.json'), 'utf8'))
const packageRoot = join(root, 'packages/activity')
const compatibility = JSON.parse(await readFile(join(packageRoot, 'compatibility.json'), 'utf8'))
if (compatibility.requiresHostPatches !== false) throw new Error('The installable package must not require host patches')
const toolFix = compatibility.buildToolFix
if (createHash('sha256').update(await readFile(join(root, toolFix.path))).digest('hex') !== toolFix.sha256) throw new Error('Build-tool fix checksum mismatch')
const dist = join(root, 'dist'); await mkdir(dist, { recursive: true })
const pnpm = JSON.parse(await readFile(join(dsh, 'node_modules/pnpm/package.json'), 'utf8'))
const packed = spawnSync(process.execPath, [resolve(dsh, 'node_modules/pnpm', pnpm.bin.pnpm), 'pack', '--pack-destination', dist], { cwd: packageRoot, stdio: 'inherit', windowsHide: true })
if (packed.status !== 0) process.exit(packed.status ?? 1)
for (const file of ['README.md', 'README_EN.md', 'compatibility.json', 'LICENSE']) await copyFile(join(packageRoot, file), join(dist, file))
await copyFile(join(root, 'docs/VALIDATION.md'), join(dist, 'VALIDATION.md'))
await mkdir(join(dist, 'images'), { recursive: true })
for (const file of ['activity-light.png', 'activity-dark.png', 'activity-narrow.png']) await copyFile(join(root, 'docs/images', file), join(dist, 'images', file))
const sources = {}
async function include(path) { sources[path] = new Uint8Array(await readFile(join(root, path))) }
async function directory(path) {
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const next = path + '/' + entry.name
    if (entry.isDirectory()) await directory(next)
    else if (entry.isFile()) await include(next)
  }
}
for (const file of ['README.md', 'README_EN.md', 'LICENSE', 'CHANGELOG.md', 'package.json', '.gitignore', '.gitattributes', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.host.json', 'tsconfig.client.json', 'vitest.config.ts',
  'packages/activity/package.json', 'packages/activity/tsconfig.host.json', 'packages/activity/tsconfig.client.json', 'packages/activity/README.md', 'packages/activity/README_EN.md', 'packages/activity/LICENSE', 'packages/activity/cordis.patch.yml', 'packages/activity/compatibility.json']) await include(file)
for (const path of ['.github', 'docs', 'scripts', 'tests', 'packages/activity/src']) await directory(path)
await writeFile(join(dist, 'BetterActivity-source.zip'), zipSync(sources, { level: 6 }))
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const checksums = []
for (const file of [`${manifest.name}-${manifest.version}.tgz`, 'BetterActivity-source.zip', 'compatibility.json', 'VALIDATION.md']) {
  checksums.push(createHash('sha256').update(await readFile(join(dist, file))).digest('hex') + '  ' + file)
}
await writeFile(join(dist, 'SHA256SUMS'), checksums.join('\n') + '\n')
console.log('Distribution written to ' + dist)
