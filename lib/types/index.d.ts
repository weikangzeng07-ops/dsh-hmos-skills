/**
 * Type surface for the `dsh-hmos-skills` Cordis plugin.
 *
 * The runtime contract this package depends on is the `ctx.skills` service of
 * `@deepseek-ai/dsh-skill`; these declarations stay self-contained so a consumer
 * can type the plugin without pulling in the harness packages.
 */

/** Plugin configuration accepted by {@link apply}. */
export interface HmosSkillsConfig {
  /** Provider name registered on `ctx.skills`. Default `"hmos"`. */
  providerName?: string
  /** Absolute skill root to serve instead of the bundled `skills/` directory. */
  skillsDir?: string
  /**
   * Prepend the DSH runtime note to every loaded body.
   * The note maps upstream agent tool names to DSH tools and resolves
   * `${SKILL_DIR}`. Default `true`.
   */
  environmentNote?: boolean
  /**
   * Duplicate-name precedence within the registry layer.
   * Default `600` (`BUNDLED_SKILL_RANK`): lower ranks win.
   */
  rank?: number
  /** Prompt-visible origin bucket reported for these skills. Default `"bundled"`. */
  source?: string
}

/** Parsed result of a `SKILL.md` frontmatter block. */
export interface ParsedFrontmatter {
  /** Frontmatter keys; unknown keys are preserved verbatim. */
  data: Record<string, unknown>
  /** Instruction body with the frontmatter block removed. */
  body: string
}

/**
 * Split a `SKILL.md` document into its frontmatter mapping and instruction body.
 * A file without usable frontmatter yields an empty mapping and the whole text.
 */
export declare function parseFrontmatter(text: string): ParsedFrontmatter

/** Cordis plugin name. */
export declare const name: 'hmos-skills'

/** Services this plugin requires before it activates. */
export declare const inject: readonly ['skills']

/** Register the bundled HarmonyOS skill provider on `ctx.skills`. */
export declare function apply(ctx: unknown, config?: HmosSkillsConfig): void

// Intentionally no default export: the Cordis loader unwraps a plugin module
// with `exports.default ?? exports`, so a default export would replace the
// namespace and drop the named `inject`/`name` declared above.
