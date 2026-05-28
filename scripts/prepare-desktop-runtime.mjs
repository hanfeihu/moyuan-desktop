import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeSource = path.join(root, 'services/codex-runtime')
const runtimeTarget = path.join(root, 'apps/desktop/.moyuan-runtime/services/codex-runtime')
const sharedSource = path.join(root, 'packages/shared')
const sharedTarget = path.join(runtimeTarget, 'node_modules/@eaw/shared')
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32', stdio: 'inherit' })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}

await rm(path.join(root, 'apps/desktop/.moyuan-runtime'), { force: true, recursive: true })
await mkdir(runtimeTarget, { recursive: true })
await cp(path.join(runtimeSource, 'dist'), path.join(runtimeTarget, 'dist'), { recursive: true })

const runtimePackage = JSON.parse(await readFile(path.join(runtimeSource, 'package.json'), 'utf8'))
const dependencies = { ...runtimePackage.dependencies }
delete dependencies['@eaw/shared']

await writeFile(
  path.join(runtimeTarget, 'package.json'),
  `${JSON.stringify(
    {
      name: '@moyuan/packaged-codex-runtime',
      version: runtimePackage.version,
      private: true,
      type: 'module',
      main: 'dist/index.js',
      dependencies,
    },
    null,
    2,
  )}\n`,
)

await run(npmBin, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], runtimeTarget)

const sharedPackage = JSON.parse(await readFile(path.join(sharedSource, 'package.json'), 'utf8'))
await mkdir(sharedTarget, { recursive: true })
await cp(path.join(sharedSource, 'dist'), path.join(sharedTarget, 'dist'), { recursive: true })
await writeFile(
  path.join(sharedTarget, 'package.json'),
  `${JSON.stringify(
    {
      name: sharedPackage.name,
      version: sharedPackage.version,
      private: true,
      type: 'module',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
    },
    null,
    2,
  )}\n`,
)
