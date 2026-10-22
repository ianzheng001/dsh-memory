/**
 * Resolve Host-owned modules without declaring runtime dependencies.
 *
 * A `link:`-installed plugin gets no dependency tree from pnpm, so bare
 * specifiers may resolve to nothing or to a different copy than the running
 * product. Every Host module is resolved through an anchor derived from the
 * running process, which keeps a single module instance per product.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Anchors tried in order; each is a path `createRequire` can resolve from. */
function candidateAnchors() {
  const anchors = []
  const explicit = process.env.DSH_ANCHOR
  if (typeof explicit === 'string' && explicit.length > 0) anchors.push(explicit)
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    // `<pkg>/lib/bin.js` → `<pkg>/package.json`
    if (argv1.endsWith(join('lib', 'bin.js'))) anchors.push(join(dirname(argv1), '..', 'package.json'))
    // `/…/node_modules/@scope/name/lib/x.js` → `/…/node_modules/@scope/name/package.json`
    const inside = /^(.*?[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(argv1)
    if (inside !== null) anchors.push(join(inside[1], 'package.json'))
    anchors.push(join(dirname(argv1), 'package.json'))
  }
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (bin.length > 0) anchors.push(join(dirname(realpathSync(bin)), '..', 'package.json'))
  } catch {
    // No `dsh` on PATH (Desktop-only install); other anchors still apply.
  }
  anchors.push(join(process.cwd(), 'package.json'))
  anchors.push(import.meta.url)
  return anchors
}

/**
 * Require a Host module (CommonJS entry point).
 * @param {string} specifier - bare or relative module specifier.
 * @returns {any} the module namespace.
 */
export function hostRequire(specifier) {
  const failures = []
  for (const anchor of candidateAnchors()) {
    try {
      return createRequire(anchor)(specifier)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error}`)
    }
  }
  throw new Error(`dsh-memory: cannot resolve "${specifier}" from the Host. Tried:\n${failures.join('\n')}`)
}

/**
 * Import a Host ES module. Node 20+ may still refuse `require()` of ESM, so
 * resolve the file with a Host-anchored `require` and import it by URL.
 * @param {string} specifier - bare or relative module specifier.
 * @returns {Promise<any>} the module namespace.
 */
export async function hostImport(specifier) {
  const failures = []
  for (const anchor of candidateAnchors()) {
    let resolved
    try {
      resolved = createRequire(anchor).resolve(specifier)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error}`)
      continue
    }
    return import(pathToFileURL(resolved).href)
  }
  throw new Error(`dsh-memory: cannot import "${specifier}" from the Host. Tried:\n${failures.join('\n')}`)
}
