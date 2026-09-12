#!/usr/bin/env node
/**
 * Dependency-free smoke test for the bundled HarmonyOS skill provider.
 *
 * Two things are checked:
 *
 * 1. **Plugin shape as the Cordis loader sees it.** `cordis-plugin-loader`'s
 *    `unwrapExports` normalizes a module with `exports.default ?? exports`, so a
 *    default export silently replaces the namespace and drops the named
 *    `inject`/`name`. The row then mounts without its service declaration and
 *    the whole plugin tree fails with
 *    `cannot get property "skills" without inject`. This is asserted first,
 *    because it is the one failure that stops DSH from booting at all.
 * 2. **Provider behaviour** against a minimal stand-in for `ctx.skills`: no
 *    harness packages required. Checks the invariants the real registry
 *    enforces — kebab-case names, non-empty descriptions inside the catalog
 *    cap, unique names, resolvable bodies, and a resolved `${SKILL_DIR}`.
 *
 *   node scripts/smoke.mjs
 */
import * as pluginModule from '../lib/index.js'

const problems = []
const fail = (message) => problems.push(message)

// --- 1. loader-faithful shape check -----------------------------------------
// Mirrors cordis-plugin-loader/lib/index.js unwrapExports().
const unwrapped = pluginModule.default ?? pluginModule

if (typeof unwrapped !== 'object' || unwrapped === null) {
  fail(
    'loader shape: unwrapExports() would hand Cordis a bare function, not the module '
    + 'namespace — remove the `export default` from lib/index.js, otherwise `inject` is dropped '
    + 'and DSH fails to boot with `cannot get property "skills" without inject`',
  )
} else {
  if (typeof unwrapped.apply !== 'function') fail('loader shape: the unwrapped plugin has no apply()')
  if (!Array.isArray(unwrapped.inject) || !unwrapped.inject.includes('skills')) {
    fail('loader shape: the unwrapped plugin does not declare inject: ["skills"]')
  }
  if (typeof unwrapped.name !== 'string' || unwrapped.name === '') {
    fail('loader shape: the unwrapped plugin has no name')
  }
}

const apply = typeof unwrapped === 'function' ? unwrapped : unwrapped.apply

// --- 2. provider behaviour ---------------------------------------------------
/** Mount the plugin and return the provider it registered. */
function mount(config) {
  let provider
  const ctx = {
    skills: {
      registerProvider(create) {
        provider = create({ signal: new AbortController().signal, invalidate() {} })
        return () => {}
      },
    },
  }
  apply(ctx, config)
  if (provider === undefined) throw new Error('apply() did not register a provider')
  return provider
}

const provider = mount()
const candidates = await provider.list({})
const seen = new Set()

for (const candidate of candidates) {
  const fail = (message) => problems.push(`${candidate.name}: ${message}`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate.name)) fail('invalid kebab-case name')
  if (seen.has(candidate.name)) fail('duplicate name')
  seen.add(candidate.name)
  if (typeof candidate.description !== 'string' || candidate.description.trim() === '') fail('empty description')
  if (candidate.description.length > 500) fail(`description is ${candidate.description.length} chars, over the 500-char catalog cap`)
  if (candidate.invocation?.modelInvocable !== true) fail('not model-invocable')
  if (candidate.resourceBase?.kind !== 'directory') fail('missing directory resource base')

  const definition = await provider.get(candidate, {})
  if (definition === undefined) {
    fail('get() returned undefined')
    continue
  }
  if (definition.name !== candidate.name) fail(`get() returned ${definition.name}`)
  if (definition.content.trim() === '') fail('empty body')
  if (!definition.content.includes('DSH runtime note')) fail('runtime note was not injected')
}

// With the runtime note disabled, nothing but the skill text remains: the
// placeholder must already be resolved there, and no note may leak in.
const bare = mount({ environmentNote: false })
let resolved = 0
for (const candidate of candidates) {
  const definition = await bare.get(candidate, {})
  if (definition.content.includes('${SKILL_DIR}')) problems.push(`${candidate.name}: unresolved ${'${SKILL_DIR}'} in body`)
  if (definition.content.includes('DSH runtime note')) problems.push(`${candidate.name}: runtime note leaked`)
  if (definition.content.includes(definition.resourceBase.path)) resolved += 1
}

console.log(`skills: ${candidates.length}`)
for (const candidate of candidates) {
  console.log(`  ${candidate.name.padEnd(40)} ${String(candidate.description.length).padStart(3)} chars`)
}
console.log(`\nbodies that reference their own directory: ${resolved}`)

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('OK: every skill lists and loads cleanly')
