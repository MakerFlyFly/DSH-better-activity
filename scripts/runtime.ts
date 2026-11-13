/** Resolve an isolated official CLI; source checkouts are explicit coexistence-test overrides. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface DshRuntime { cwd: string; args: string[]; stock: boolean; version: string }

/** @param root - Plugin workspace. @returns A pinned CLI launcher without changing the runtime. */
export async function resolveRuntime(root: string): Promise<DshRuntime> {
  const required = JSON.parse(await readFile(join(root, 'packages/activity/compatibility.json'), 'utf8')).dshVersion as string
  const source = process.env.BETTER_ACTIVITY_TEST_SOURCE_DSH
  if (source) {
    const cwd = resolve(source)
    const version = JSON.parse(await readFile(join(cwd, 'apps/cli/package.json'), 'utf8')).version as string
    if (version !== required) throw new Error(`Coexistence source must use DSH ${required}`)
    return { cwd, args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'], stock: false, version }
  }
  let location = process.env.BETTER_ACTIVITY_TEST_RUNTIME
  if (!location) location = (JSON.parse(await readFile(join(root, '.dev/runtime.json'), 'utf8')) as { path: string }).path
  const cwd = resolve(location)
  const directory = join(cwd, 'node_modules/@deepseek-ai/dsh')
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version: string; bin: string | { dsh: string } }
  if (pkg.version !== required) throw new Error(`Install official @deepseek-ai/dsh@${required} in the isolated runtime directory`)
  return { cwd, args: [join(directory, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh)], stock: true, version: pkg.version }
}
