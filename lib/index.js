/**
 * Bundled HarmonyOS skill provider for DeepSeek Harness.
 *
 * Registers every `skills/<name>/SKILL.md` bundle shipped with this package as
 * a `ctx.skills` provider, so the 39 ported `hmos-*` skills appear in the
 * session skill catalog and load through the ordinary `skill` tool.
 *
 * The provider is deliberately dependency-free: frontmatter is parsed by a
 * small YAML-subset reader that covers exactly the constructs this corpus uses
 * (plain / quoted / block scalars and nested `metadata` mappings), so the
 * package installs and mounts without a resolution step.
 *
 * @module dsh-hmos-skills
 */

import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'hmos-skills'

/** The skill registry this provider registers on. */
export const inject = ['skills']

/** Published `BUNDLED_SKILL_RANK` of `@deepseek-ai/dsh-skill`. */
const BUNDLED_SKILL_RANK = 600

const DEFAULT_PROVIDER_NAME = 'hmos'
const DEFAULT_SOURCE = 'bundled'
const SKILL_FILE = 'SKILL.md'
const SKILL_DIR_PLACEHOLDER = '${SKILL_DIR}'
const KEBAB = /^[a-z0-9][a-z0-9-]*$/

/** Absolute path of the bundled skill root: `<package>/skills/`. */
const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/**
 * The porting note prepended to every loaded body. It is injected by this
 * plugin, not by the upstream skill bundle, and is what makes the ported text
 * executable in DSH rather than in Claude Code.
 */
function environmentNote(dir) {
  return [
    '> **DSH runtime note — injected by `dsh-hmos-skills`, not part of the upstream skill text.**',
    '> - Tool names in this document map to DSH tools: `Glob`→`glob`, `Grep`→`grep`, `Read`→`read`,',
    '>   `Write`→`write`, `Edit`/`SearchReplace`→`edit`, `Bash`→`pwsh`, `TodoWrite`/`todowrite`→`todo_write`,',
    '>   `Task`/`Agent`→`subagent`, `WebSearch`→`web_search`, `WebFetch`→`web_fetch`.',
    `> - \`${SKILL_DIR_PLACEHOLDER}\` is resolved to this skill's install directory: \`${dir}\`.`,
    '>   Relative paths such as `references/`, `assets/`, and `scripts/` resolve against it, and the same',
    '>   placeholder inside any referenced file means the same directory.',
    '> - Steps that need DevEco Studio / `hvigor` / `hdc` / `ohpm` require a local HarmonyOS toolchain',
    '>   (`DEVECO_SDK_HOME` set, `hvigorw` at the project root). Verify with `pwsh` first; when the toolchain',
    '>   is unavailable, follow the documented fallback and say plainly that no real build was performed.',
    '> - CodeGenie names (`mcp_codegenie-*`, `builtin_*`) do not exist here; substitute `pwsh` plus the',
    '>   bundled `hmos-arkts-knowledge-retriever` / `hmos-arkui-knowledge-retriever` knowledge bases.',
    '',
  ].join('\n')
}

// --------------------------------------------------------------- frontmatter

/** Strip a leading BOM without touching the rest of the text. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Parse a YAML scalar written on the key's own line. */
function parseScalar(raw) {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Remove the common leading indentation of a block. */
function dedent(lines) {
  let indent = Infinity
  for (const line of lines) {
    if (line.trim() === '') continue
    indent = Math.min(indent, line.match(/^[ \t]*/)[0].length)
  }
  if (!Number.isFinite(indent) || indent === 0) return lines
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(indent)))
}

/** Render a `|` / `>` block scalar with its chomping indicator. */
function renderBlockScalar(style, chomp, lines) {
  let out
  if (style === '|') {
    out = lines.join('\n')
  } else {
    // Folded: a blank line becomes a newline, every other break becomes a space.
    out = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (i === 0) out = line
      else if (line === '') out += '\n'
      else if (lines[i - 1] === '') out += line
      else out += ` ${line}`
    }
  }
  if (chomp === '-') return out.replace(/\n+$/, '')
  if (chomp === '+') return `${out}\n`
  return `${out.replace(/\n+$/, '')}\n`
}

/** Parse the indented body that follows a bare `key:` line. */
function parseIndented(lines) {
  const first = lines.find((line) => line.trim() !== '')
  const isSequence = first !== undefined && /^\s*-\s/.test(first)
  if (isSequence) {
    const items = []
    let current = null
    for (const line of lines) {
      const m = /^\s*-\s*(.*)$/.exec(line)
      if (m) {
        if (current !== null) items.push(current)
        current = parseScalar(m[1])
      } else if (current !== null && line.trim() !== '') {
        current += ` ${line.trim()}`
      }
    }
    if (current !== null) items.push(current)
    return items
  }
  return parseMapping(lines)
}

const KEY_RE = /^([A-Za-z0-9_.-]+):(.*)$/

/**
 * Parse a flat or one-level-nested YAML mapping.
 * @param lines - de-indented mapping lines.
 * @returns the parsed mapping.
 */
function parseMapping(lines) {
  const out = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1
      continue
    }
    const m = KEY_RE.exec(line)
    if (!m) {
      i += 1
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    if (rest === '') {
      const block = []
      i += 1
      while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) {
        block.push(lines[i])
        i += 1
      }
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
      out[key] = block.length === 0 ? '' : parseIndented(dedent(block))
    } else if (/^[|>][+-]?$/.test(rest) || /^[|>]\d*[+-]?$/.test(rest)) {
      const style = rest[0]
      const chomp = /[-+]/.test(rest) ? rest[rest.length - 1] : ''
      const block = []
      i += 1
      while (i < lines.length && (lines[i].trim() === '' || /^[ \t]/.test(lines[i]))) {
        block.push(lines[i])
        i += 1
      }
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
      out[key] = renderBlockScalar(style, chomp, dedent(block))
    } else {
      out[key] = parseScalar(rest)
      i += 1
    }
  }
  return out
}

/**
 * Split a SKILL.md into its frontmatter mapping and its instruction body.
 * A file without usable frontmatter yields an empty mapping and the whole text.
 * @param text - raw SKILL.md contents.
 * @returns the frontmatter mapping plus the body.
 */
export function parseFrontmatter(text) {
  const src = stripBom(text)
  const firstBreak = src.indexOf('\n')
  if (firstBreak === -1 || src.slice(0, firstBreak).trim() !== '---') return { data: {}, body: src }
  const lines = src.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, body: src }
  let data = {}
  try {
    data = parseMapping(lines.slice(1, end))
  } catch {
    data = {}
  }
  return { data, body: lines.slice(end + 1).join('\n') }
}

/** Collapse a description to one routing-friendly line. */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Derive a fallback description from the body when frontmatter lacks one. */
function fallbackDescription(body) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('>') || line.startsWith('|')) continue
    return oneLine(line).slice(0, 400)
  }
  return 'HarmonyOS development skill.'
}

/** Read the invocation booleans, accepting the strict spellings DSH documents. */
function parseFlag(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(v)) return true
  if (['false', 'no', 'off', '0'].includes(v)) return false
  return undefined
}

// ------------------------------------------------------------------ provider

/**
 * Build the provider object registered on `ctx.skills`.
 * @param options - resolved plugin configuration.
 * @returns a `SkillProvider` over the bundled skill directory.
 */
function createProvider(options) {
  const { providerName, skillsDir, rank, source, note } = options

  async function readCandidate(dirName) {
    const directory = join(skillsDir, dirName)
    let text
    try {
      text = await readFile(join(directory, SKILL_FILE), 'utf8')
    } catch {
      return undefined
    }
    const { data, body } = parseFrontmatter(text)
    const name = typeof data.name === 'string' && KEBAB.test(data.name.trim()) ? data.name.trim() : dirName
    if (!KEBAB.test(name)) return undefined
    const description = oneLine(data.description) || fallbackDescription(body)
    const modelInvocable = parseFlag(data['disable-model-invocation']) !== true
    const userInvocable = parseFlag(data['user-invocable']) !== false
    const whenToUse = oneLine(data.whenToUse)
    return {
      name,
      description,
      ...(whenToUse === '' ? {} : { whenToUse }),
      invocation: { modelInvocable, userInvocable },
      provider: providerName,
      source,
      resourceBase: { kind: 'directory', path: directory },
      rank,
      locator: { name, path: join(directory, SKILL_FILE), directory },
      path: join(directory, SKILL_FILE),
      ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
        ? { metadata: data.metadata }
        : {}),
    }
  }

  return {
    name: providerName,
    async list() {
      let entries
      try {
        entries = await readdir(skillsDir, { withFileTypes: true })
      } catch {
        return []
      }
      const dirNames = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      const candidates = []
      for (const dirName of dirNames) {
        const candidate = await readCandidate(dirName)
        if (candidate !== undefined) candidates.push(candidate)
      }
      return candidates
    },
    async get(candidate) {
      const locator = candidate.locator
      let text
      try {
        text = await readFile(locator.path, 'utf8')
      } catch {
        return undefined
      }
      const { data, body } = parseFrontmatter(text)
      const name = typeof data.name === 'string' && KEBAB.test(data.name.trim()) ? data.name.trim() : locator.name
      if (name !== candidate.name) return undefined
      const content = body
        .split(SKILL_DIR_PLACEHOLDER)
        .join(locator.directory)
      return {
        name: candidate.name,
        description: oneLine(data.description) || candidate.description,
        ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
        invocation: candidate.invocation,
        provider: providerName,
        source,
        resourceBase: { kind: 'directory', path: locator.directory },
        path: locator.path,
        ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
          ? { metadata: data.metadata }
          : {}),
        content: note ? `${environmentNote(locator.directory)}\n${content}` : content,
      }
    },
  }
}

/**
 * Register the bundled HarmonyOS skill provider on `ctx.skills`.
 * @param ctx - Cordis context carrying the skill registry.
 * @param config - optional plugin configuration.
 */
export function apply(ctx, config = {}) {
  const providerName = typeof config.providerName === 'string' && config.providerName !== ''
    ? config.providerName
    : DEFAULT_PROVIDER_NAME
  const provider = createProvider({
    providerName,
    skillsDir: typeof config.skillsDir === 'string' && config.skillsDir !== ''
      ? config.skillsDir
      : DEFAULT_SKILLS_DIR,
    rank: Number.isInteger(config.rank) ? config.rank : BUNDLED_SKILL_RANK,
    source: typeof config.source === 'string' && config.source !== '' ? config.source : DEFAULT_SOURCE,
    note: config.environmentNote !== false,
  })
  ctx.skills.registerProvider(() => provider)
}

// Deliberately NO `export default`. The Cordis loader normalizes a plugin module
// with `exports.default ?? exports`, so a default export replaces the module
// namespace and the named `inject`/`name` are discarded. The row then mounts
// without its service declaration and takes the whole plugin tree down with
// `cannot get property "skills" without inject`. Exporting named fields only
// keeps the namespace object — which Cordis's `isApplicable` accepts — and
// preserves `inject`. `scripts/smoke.mjs` asserts this shape.
