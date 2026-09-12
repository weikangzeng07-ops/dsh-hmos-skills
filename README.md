# dsh-hmos-skills

**HarmonyOS (鸿蒙) development skills for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 39 official `hmos-*` skill bundles, ported to the DSH skill registry.**

English | [中文](README.zh.md)

`dsh-hmos-skills` is a DSH plugin bundle. One command installs it, and from the
next session onward the agent receives all 39 HarmonyOS skills in its skill
catalog and can load any of them with the ordinary `skill` tool — ArkTS / ArkUI
development, multi-device adaptation, Atomic Service / ASCF, Kit integration,
local and instrument testing, and DFX crash / leak analysis.

The upstream bundles are written for Claude Code. This package makes them run
*as DSH skills*: frontmatter is normalised to what the registry validates,
Claude Code tool names are mapped to their DSH equivalents, `${SKILL_DIR}` is
resolved at load time, and the whole corpus is served by a dependency-free
`ctx.skills` provider.

---

## Install

```sh
dsh plugin --profile <profile> add github:weikangzeng07-ops/dsh-hmos-skills
```

Restart the profile once so the host registers the new bundle. Then start a
session and check the catalog — you should see 39 `hmos-*` entries:

```
hmos-arkts-syntax-checker: 检查并修复 HarmonyOS 项目的 ArkTS 语法错误…
hmos-arkui-develop-skill:  ArkUI 代码开发助手…
hmos-jsleak-analysis:      DFX Skills，分析 HarmonyOS/ArkTS rawheap…
…
```

To remove it again:

```sh
dsh plugin --profile <profile> remove dsh-hmos-skills
```

<details>
<summary>Manual mount (any profile)</summary>

Add the row yourself instead of using the bundle channel:

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: hmos-skills
      name: 'dsh-hmos-skills'
```

The package must be resolvable from the profile directory. Do not do both — the
bundle patch and a manual row would mount the provider twice.
</details>

---

## Use

Nothing special is required: the skills are ordinary DSH skills. The agent
loads one when your request matches its description, or you invoke it directly
with `/`:

```
帮我给 entry 模块加一个折叠屏悬停态的分栏布局
```

The agent loads `hmos-multidevice-fold-state` (and `hmos-multidevice-scenario-entry`
first if the scenario is ambiguous), then follows the ported instructions.

```
/hmos-jsleak-analysis 分析这个 rawheap 快照
```

DFX skills accept log and snapshot files and drive the bundled analysis scripts:

```
分析 leak.rawheap，输出泄漏嫌疑对象和引用链
分析这份 cppcrash 日志，定位崩溃根因
运行 entry 模块的 Local Test 并给出覆盖率
```

---

## Skill catalog

39 skills across six groups. Every one is model-invocable and appears in the
session catalog.

### ArkTS / ArkUI development

| Skill | What it does |
| --- | --- |
| `hmos-arkui-develop-skill` | Generate and edit ArkUI pages and components, producing compilable `.ets` code backed by the bundled knowledge bases. |
| `hmos-arkts-syntax-checker` | 检查并修复 HarmonyOS 项目的 ArkTS 语法错误，自动化构建项目 |
| `hmos-arkts-deprecated-interface-checker` | 检查 HarmonyOS 项目中的废弃 SDK 接口并提供修复建议 |
| `hmos-arkts-knowledge-retriever` | Retrieve grounded ArkTS references for non-UI ArkTS work and ArkTS API usage. |
| `hmos-arkui-knowledge-retriever` | ArkUI 知识检索层，按问题语境自动路由到 ArkTS 声明式或 NDK(C-API)知识库进行精准检索，不涉及代码生成或修改 |
| `hmos-arkui-mvvm-pattern` | HarmonyOS ArkUI MVVM 架构技能 |
| `hmos-arkui-statemgt-migration` | 帮助开发者将ArkUI状态管理从V1迁移到V2 |
| `hmos-arkui-longtake-transition` | 为鸿蒙(HarmonyOS)应用添加一镜到底转场效果 |
| `hmos-design-visual-mobile` | HarmonyOS 移动端页面视觉还原技能 |

### Multi-device adaptation

| Skill | What it does |
| --- | --- |
| `hmos-multidevice-scenario-entry` | Entry skill for HarmonyOS multi-device adaptation. |
| `hmos-multidevice-screen-window-size` | HarmonyOS 多设备屏幕窗口尺寸适配 |
| `hmos-multidevice-fold-state` | HarmonyOS foldable-device adaptation skill for requirements, development, bug-fix, and verification phases. |
| `hmos-multidevice-avoid-areas` | Handle HarmonyOS avoid-area adaptation through a declarative scene and resource index. |
| `hmos-multidevice-interaction-methods` | HarmonyOS应用多设备交互适配开发方案skill，提供触摸、鼠标、键盘、手写笔等多输入方式的交互方案和事件归一策略 |
| `hmos-multidevice-natural-orientation` | 鸿蒙 HarmonyOS 屏幕方向与旋转相关的需求分析、开发实现、问题修复和功能验证 |
| `hmos-multidevice-hardware-access` | Handle HarmonyOS hardware-capability adaptation through a declarative scene and resource index. |

### Atomic Service / ASCF

| Skill | What it does |
| --- | --- |
| `hmos-atomicservice-assistant` | 辅助鸿蒙开发者构建元服务（Atomic Service / 免安装应用） |
| `hmos-ascf-assistant` | 辅助开发者使用 ASCF 工具链开发 HarmonyOS 元服务 |
| `hmos-ascf-convert-taro` | 辅助开发者将 Taro 项目适配（转换）为 ASCF 元服务 |
| `hmos-ascf-convert-uniapp` | 辅助开发者将 uni-app 项目适配(转换)为 ASCF 元服务 |

### Kit integration

| Skill | What it does |
| --- | --- |
| `hmos-push-kit` | 华为 Push Kit 推送服务集成助手（Master Skill / 大路由） |
| `hmos-push-kit-token` | Push Token 获取助手，可作为单独接入能力使用 |
| `hmos-push-kit-notification` | Notification message helper: push notifications, message alerts, notification styles and click actions. |
| `hmos-push-kit-voip` | In-app call (VoIP) push helper: voice/video incoming-call notifications and the call UI. |
| `hmos-push-kit-background` | Background message push helper: silent data updates and message caching. |
| `hmos-scan-kit-defaultscan` | 帮助开发者快速接入华为 Scan Kit 默认界面扫码能力，在不需要完全自定义相机界面、闪光灯控制、变焦、对焦等高级功能时优先使用 |
| `hmos-scan-kit-customscan` | 帮助开发者快速接入华为 Scan Kit 自定义界面扫码能力，仅在需要支持完全自定义相机预览流 UI 界面、闪光灯控制、变焦、对焦等功能的场景使用 |
| `hmos-account-kit-quicklogin-client` | 基于 HarmonyOS Account Kit 提供华为账号一键登录客户端接入指引，实现获取匿名手机号接口与华为账号一键登录组件集成 |
| `hmos-live-view-kit-build-location` | HarmonyOS实况窗（LiveView）代码生成助手，支持创建、更新、停止实况窗 |

### Testing

| Skill | What it does |
| --- | --- |
| `hmos-local-test` | 在 HarmonyOS 应用/服务开发中执行模块的 Local Test（ArkTS/JS 单元测试），支持运行、覆盖率统计等模式，并可指定测试范围（模块、测试套件、单个用例） |
| `hmos-instrument-test` | 在 HarmonyOS 应用/服务开发中执行模块的 Instrument Test（包括 ArkTS/JS 和 C++ 测试），支持运行、覆盖率统计、ASan 检测等模式，并可指定测试范围（模块、测试套件、单个用例） |

### DFX fault analysis

| Skill | What it does |
| --- | --- |
| `hmos-apifault-analysis` | Diagnose API failures, error codes and crash/freeze logs; emits a structured root-cause report. |
| `hmos-appfreeze-analysis` | DFX Skills，自动分析 HarmonyOS / OpenHarmony Freeze（冻屏/卡死）故障日志，定位根因并输出完整证据链 |
| `hmos-jscrash-analysis` | Analyze JS Crash (ArkTS/JS) faultlogger logs and locate the root cause. |
| `hmos-cppcrash-analysis` | Analyze CppCrash (native layer) logs: signals, registers, native stacks and symbols. |
| `hmos-fdleak-analysis` | Analyze FD / handle leak logs and pinpoint the leaking allocation stack. |
| `hmos-jsleak-analysis` | DFX Skills，分析 HarmonyOS/ArkTS rawheap、heapsnapshot 和 Heap Cluster 报告，识别疑似 JS 内存泄漏 |
| `hmos-native-memleak-analysis` | Analyze native memory leaks from sample, smaps and profiler flame-graph evidence. |
| `hmos-memleak-analysis` | Static analysis of ArkTS, JS and C/C++ sources for memory leaks. |

---

## How it works

The package is a single Cordis plugin.

```
cordis.patch.yml ──insert──▶ dsh-hmos-skills  (lib/index.js)
                                   │  ctx.skills.registerProvider()
                                   ▼
                         @deepseek-ai/dsh-skill   ◀── @deepseek-ai/dsh-tool-skill
                         (merged skill registry)      (session catalog + `skill` tool)
                                   ▲
                              skills/*/SKILL.md   (39 bundles, this repo)
```

* **One provider, rank 600.** `lib/index.js` registers a provider named `hmos`
  on `ctx.skills` at `BUNDLED_SKILL_RANK`, so a project skill in
  `<project>/.dsh/skills` (rank 100) or a user skill in `~/.dsh/skills`
  (rank 400) with the same name still wins. Your local edits always take
  precedence.
* **Discovery is a directory scan.** `list()` reads `skills/*/SKILL.md`,
  parses the frontmatter and returns candidates; `get()` re-reads the file on
  every load, so editing a skill body takes effect on the next load with no
  cache to invalidate.
* **Zero runtime dependencies.** Frontmatter is parsed by a ~120-line
  YAML-subset reader covering exactly the constructs this corpus uses (plain,
  quoted and `|` / `>` block scalars, plus nested `metadata` mappings). It is
  verified to produce output identical to the `yaml` package on all 39 files.
* **Resources resolve on disk.** Each candidate carries a directory
  `resourceBase`, so `references/`, `assets/` and `scripts/` paths inside a
  skill resolve against its own install directory.
* **No `export default`.** The Cordis loader normalizes a plugin module with
  `exports.default ?? exports`, so a default export would *replace* the module
  namespace and drop the named `inject`. The row would then mount without its
  service declaration and DSH would fail to boot with
  `cannot get property "skills" without inject`. `lib/index.js` therefore
  exports named fields only — the shape the shipped `dsh-skill-badge` provider
  uses — and `scripts/smoke.mjs` asserts that shape before anything else.

## What the port changed

The upstream bundles are Claude Code content. Seven things had to change to
make them real DSH skills.

| # | Change | Why |
| --- | --- | --- |
| 1 | **Frontmatter normalised** for all 39 bundles | DSH requires `name` + `description`; the upstream files also carry `license`, `compatibility`, `version` and `category` at top level. Those move under `metadata`, and the key set is re-emitted in a fixed order. |
| 2 | **Descriptions trimmed to the 500-char catalog cap** (9 skills) | `dsh-tool-skill` truncates catalog descriptions at `catalogDescriptionMaxLength` (500) with a trailing `...`. `hmos-push-kit`'s description was 994 chars, so its routing table — the part that decides which sub-skill loads — was being cut off. The trimmed text keeps every trigger and routing rule; the full upstream text stays in the skill body. |
| 3 | **`hmos-push-kit` sub-skills flattened** | The upstream bundle nests 4 sub-skills under `hmos-push-kit/`, and DSH discovery is one level deep (`<root>/<name>/SKILL.md`). The sub-skills are now siblings, each with its own copy of `references/push-error-codes.md` so their relative links resolve. |
| 4 | **`${SKILL_DIR}` resolved at load time** | Upstream writes `{skill_dir}` / `$SKILL_DIR` / `${SKILL_DIR}` in 3 skills. All spellings are unified at port time, and the provider substitutes the real absolute path when the body loads. |
| 5 | **Claude Code tool names mapped** | `Glob`/`Grep`/`Read`/`Write`/`Edit`/`SearchReplace`/`Bash`/`TodoWrite`/`Task`/`WebSearch`/`WebFetch` become `glob`/`grep`/`read`/`write`/`edit`/`pwsh`/`todo_write`/`subagent`/`web_search`/`web_fetch`. In-file edits where a literal tool name would mislead, plus a runtime note prepended to every loaded body. |
| 6 | **CodeGenie MCP dependencies replaced** | `hmos-arkts-syntax-checker`, `hmos-arkts-deprecated-interface-checker`, `hmos-account-kit-quicklogin-client` and the Scan Kit skills build their whole workflow on DevEco Studio's CodeGenie MCP tools (`mcp_codegenie-mcp_check_ets_files`, `mcp_codegenie-mcp_build_project`, `builtin_*`), which do not exist outside DevEco. Each got an explicit DSH mapping — drive `hvigorw` through `pwsh`, or fall back to the bundled knowledge-retriever lint tooling and say plainly that no real build was performed — and their flowcharts, decision trees, checklists and tool tables were updated to match. `hmos-apifault-analysis/references/tool_mapping.md` was rewritten for DSH. |
| 7 | **`.claude/skills` → `.dsh/skills`** | `hmos-multidevice-scenario-entry`'s remote-loading doc and `remote_load.sh` described a Claude Code workspace layout; `dsh` is now a first-class platform in that installer. Evaluation fixtures listing an `allowed_tools` array were renamed to the DSH tools. |

Nothing else in the ~2,300 files was touched: bodies, references, assets and
scripts are byte-identical to upstream apart from the changes above.

## Prerequisites

The skills are usable out of the box for reading, planning and code generation.
Some capabilities need a local HarmonyOS toolchain, and the ported text says so
explicitly rather than pretending otherwise:

| Capability | Needs |
| --- | --- |
| Building / compiling (`hmos-arkts-syntax-checker`, `hmos-account-kit-quicklogin-client`, Scan Kit) | DevEco Studio, `DEVECO_SDK_HOME` set, `hvigorw` at the project root |
| Local / Instrument tests | `hdc` (device or emulator), DevEco Studio |
| DFX log analysis (`*-analysis` skills) | Python 3 for the bundled parsers; `heap_cluster` runs on Node 22.5+ (24 recommended) |
| JS leak clustering | `pnpm install` inside `skills/hmos-jsleak-analysis/scripts/node/` (the lockfile is included) |
| ArkTS lint tool | `npm ci` inside `skills/hmos-arkts-knowledge-retriever/linter-cli/` |

## Configuration

All settings are optional and have working defaults:

```yaml
- insert:
    - id: hmos-skills
      name: 'dsh-hmos-skills'
      config:
        providerName: hmos      # provider name registered on ctx.skills
        environmentNote: true   # prepend the DSH runtime note on every load
        skillsDir: /abs/path    # serve a different skill root
        rank: 600               # duplicate-name precedence (lower wins)
        source: bundled         # prompt-visible origin bucket
```

Set `environmentNote: false` to serve the upstream text untouched.

## Verifying

```sh
node scripts/smoke.mjs
```

Lists every skill through the bundled provider and asserts the invariants the
registry enforces: kebab-case names, unique names, non-empty descriptions
inside the catalog cap, model-invocable policy, a directory resource base,
non-empty bodies, an injected runtime note, and no unresolved
`${SKILL_DIR}` — the last one checked with the note disabled so the
placeholder must be resolved in the skill text itself.

## Repository layout

```
dsh-hmos-skills/
├── cordis.patch.yml       # dsh.bundle.patch: the one inserted plugin row
├── package.json           # dsh.bundle.patch -> ./cordis.patch.yml
├── lib/
│   ├── index.js           # the provider (zero dependencies)
│   └── types/index.d.ts
├── scripts/smoke.mjs      # standalone verification
└── skills/                # 39 bundles, one directory each
    ├── hmos-arkts-syntax-checker/
    │   ├── SKILL.md
    │   └── references/
    ├── hmos-jsleak-analysis/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/       # rawheap translator, Node heap-cluster source
    └── …
```

## Repository size

This repository is ~267 MB because the DFX and knowledge skills ship real
tooling — the `llvm-objdump` / `llvm-addr2line` symbolizers, `trace_streamer`,
`rawheap_translator`, HarmonyOS design fonts and the ArkTS/ArkUI knowledge
bases.

Two things are deliberately **not** committed:

| Excluded | Size | How to get it |
| --- | --- | --- |
| `skills/hmos-jsleak-analysis/scripts/{windows,linux,macos}/heap_cluster*` | 423 MB | Every one of these exceeds GitHub's 100 MB per-file limit. The Node source release at `scripts/node/heap_cluster.js` is the documented primary path and is included — run `pnpm install` in `scripts/node/` and use it. |
| `skills/hmos-arkts-knowledge-retriever/linter-cli/node_modules/` | 45 MB | Restore with `npm ci` in `linter-cli/`; `package-lock.json` is committed. |

## Attribution and license

The skill content under `skills/` is the official HarmonyOS agent-skill
collection, published by Huawei / the OpenHarmony community (mirrored publicly
on AtomGit under `test-oh-skills/*`, and referenced throughout as the DFX
Skills and HarmonyOS multi-device skill sets). Copyright remains with the
original authors; per-skill `metadata.author` / `metadata.version` fields are
preserved verbatim in each `SKILL.md`.

The plugin code — `lib/`, `scripts/`, `cordis.patch.yml`, `package.json` — is
MIT licensed (see [LICENSE](LICENSE)).

If you are the rights holder and want this port adjusted or taken down, please
open an issue.
