# Changelog

## 1.0.0

Initial release: the HarmonyOS `hmos-*` agent-skill collection ported to the
DeepSeek Harness skill registry.

### Fixed

- **No `export default` in `lib/index.js`.** The Cordis loader normalizes a
  plugin module with `exports.default ?? exports` (`cordis-plugin-loader`'s
  `unwrapExports`). A default export therefore *replaces* the module namespace
  and the named `inject` / `name` are discarded. The row mounted as a bare
  function with no service declaration and took the whole plugin tree down:

  ```
  Error: dsh: plugin tree failed to load: failed to apply loader entry
  hmos-skills (dsh-hmos-skills): cannot get property "skills" without inject
  ```

  `dsh web` could not start at all while the plugin was installed. The module
  now exports named fields only — the shape the shipped
  `@deepseek-ai/dsh-skill-badge` provider uses — and `scripts/smoke.mjs`
  asserts the loader-visible shape (applying `unwrapExports` semantics) before
  it checks any provider behaviour, so this regression fails the smoke test
  with a message that names the exact cause.

  Standalone checks had missed it because they mounted
  `{ ...plugin, apply }`, which preserved `inject` by spreading the namespace.
  Verification now includes booting a real profile and reading the live
  `ctx.skills` catalog from inside it.

### Added

- `lib/index.js` — a zero-dependency Cordis plugin that registers one `hmos`
  skill provider on `ctx.skills` at `BUNDLED_SKILL_RANK` (600), serving every
  `skills/<name>/SKILL.md` bundle in this package.
- A ~120-line YAML-subset frontmatter reader covering plain, quoted and
  `|` / `>` block scalars plus nested `metadata` mappings.
- `scripts/smoke.mjs` — standalone verification of every registry invariant this
  package can check without a running harness.
- `cordis.patch.yml` — the `dsh.bundle.patch` layer, so one
  `dsh plugin add github:weikangzeng07-ops/dsh-hmos-skills` installs and mounts.
- 39 skill bundles across ArkTS/ArkUI development, multi-device adaptation,
  Atomic Service / ASCF, Kit integration, testing, and DFX fault analysis.

### Port changes relative to the upstream bundles

- Frontmatter normalised for all 39 bundles; top-level `license`,
  `compatibility`, `version` and `category` moved under `metadata`, and the key
  set re-emitted in a fixed order.
- Descriptions of 9 skills trimmed to fit the 500-character catalog cap
  (`dsh-tool-skill`'s `catalogDescriptionMaxLength`). `hmos-push-kit` was 994
  characters, so its sub-skill routing table was being truncated away in the
  session catalog.
- The 4 nested `hmos-push-kit-*` sub-skills flattened to the top level, since
  DSH discovery is one level deep. Each carries its own copy of
  `references/push-error-codes.md`.
- `{skill_dir}`, `$SKILL_DIR` and `${SKILL_DIR}` unified to `${SKILL_DIR}` and
  resolved to the real absolute path at load time.
- Claude Code tool names mapped to DSH tools, both in-file where a literal name
  would mislead and through a runtime note prepended to every loaded body.
- CodeGenie MCP dependencies (`mcp_codegenie-*`, `builtin_*`) replaced with
  documented DSH equivalents; `hmos-apifault-analysis/references/tool_mapping.md`
  rewritten.
- `.claude/skills` paths rewritten to `.dsh/skills`.

### Excluded from version control

- `skills/hmos-jsleak-analysis/scripts/{windows,linux,macos}/heap_cluster*`
  (423 MB) — each file exceeds GitHub's 100 MB per-file limit. The documented
  primary path, the Node source release at `scripts/node/heap_cluster.js`, is
  included.
- `skills/hmos-arkts-knowledge-retriever/linter-cli/node_modules/` (45 MB) —
  restorable with `npm ci`; `package-lock.json` is committed.
