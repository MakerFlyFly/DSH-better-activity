/** Link development dependencies to one explicitly selected DSH checkout. */
import { readdir, readFile, mkdir, symlink, lstat, unlink, writeFile, realpath } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dsh = resolve(process.argv[2] ?? join(root, '../../deepseek-harness'))
const requested = new Set([
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-generator',
  '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-context-menu', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-client-ui-session',
])
const packages = new Map()
for (const group of await readdir(join(dsh, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of await readdir(join(dsh, 'packages', group.name), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dsh, 'packages', group.name, entry.name)
    try { const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); packages.set(pkg.name, { path, version: pkg.version }) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
for (const entry of await readdir(join(dsh, 'vendor'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const path = join(dsh, 'vendor', entry.name)
  try { const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); packages.set(pkg.name, { path, version: pkg.version }) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function link(name, target) {
  const location = join(root, 'node_modules', name)
  await mkdir(dirname(location), { recursive: true })
  try {
    const stat = await lstat(location)
    if (!stat.isSymbolicLink()) throw new Error('Refusing to replace existing directory: ' + location)
    await unlink(location)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(target, location, 'junction')
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const name of requested) {
  const pkg = packages.get(name)
  if (!pkg) throw new Error('DSH package not found: ' + name)
  await link(name, pkg.path)
  manifest.devDependencies[name] = pkg.version
}
for (const name of ['zod', 'react', 'react-dom', 'clsx', 'typescript', 'tsdown', 'vitest', 'jsdom', 'fflate', '@types/node', '@types/react', '@types/react-dom', '@testing-library/react', '@testing-library/dom']) {
  let resolved
  for (const base of ['package.json', 'packages/client/ui-workspace/package.json', 'packages/client/ui-primitives/package.json', 'apps/web/package.json']) {
    try { resolved = await realpath(join(dirname(join(dsh, base)), 'node_modules', name, 'package.json')); break }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!resolved) throw new Error('Development dependency not found: ' + name)
  const path = dirname(resolved)
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
  await link(name, path)
  if (name !== 'zod') manifest.devDependencies[name] = pkg.version
}
await link('.bin', join(dsh, 'node_modules', '.bin'))
await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await mkdir(join(root, '.dev'), { recursive: true })
await writeFile(join(root, '.dev/dsh.json'), JSON.stringify({ path: dsh }) + '\n')
console.log('Development dependencies linked to ' + dsh)
