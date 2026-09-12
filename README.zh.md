# dsh-hmos-skills

**把鸿蒙（HarmonyOS）官方 Agent Skills 移植为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件 —— 39 个 `hmos-*` 技能包，接入 DSH 技能注册表。**

[English](README.md) | 中文

`dsh-hmos-skills` 是一个 DSH 插件 bundle。一条命令装好，从下一个会话开始，Agent
的技能目录里就会出现全部 39 个鸿蒙技能，可以像使用任何 DSH 技能一样用 `skill`
工具加载它们 —— 覆盖 ArkTS / ArkUI 开发、多设备适配、元服务 / ASCF、Kit 接入、
Local / Instrument 测试，以及 DFX 崩溃与泄漏分析。

上游技能包是写给 Claude Code 的。本包让它们真正**以 DSH 技能的方式运行**：
frontmatter 规范化到注册表能校验的形态，Claude Code 的工具名映射为 DSH 对应工具，
`${SKILL_DIR}` 在加载时解析为真实绝对路径，整个语料由一个零依赖的 `ctx.skills`
provider 提供。

---

## 安装

```sh
dsh plugin --profile <profile> add github:weikangzeng07-ops/dsh-hmos-skills
```

重启一次该 profile，让 Host 注册新的 bundle。然后开一个会话看技能目录，应该能看到
39 个 `hmos-*` 条目：

```
hmos-arkts-syntax-checker: 检查并修复 HarmonyOS 项目的 ArkTS 语法错误…
hmos-arkui-develop-skill:  ArkUI 代码开发助手…
hmos-jsleak-analysis:      DFX Skills，分析 HarmonyOS/ArkTS rawheap…
…
```

卸载：

```sh
dsh plugin --profile <profile> remove dsh-hmos-skills
```

<details>
<summary>手动挂载（任意 profile）</summary>

不用 bundle 通道，自己加一行：

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: hmos-skills
      name: 'dsh-hmos-skills'
```

包必须能从 profile 目录解析到。不要两种方式同时用 —— bundle patch 和手动行会挂载
两次 provider。
</details>

---

## 使用

不需要额外操作，它们就是普通的 DSH 技能：请求命中描述时 Agent 会自动加载，也可以用
`/` 直接调用。

```
帮我给 entry 模块加一个折叠屏悬停态的分栏布局
```

Agent 会加载 `hmos-multidevice-fold-state`（场景不明确时先走
`hmos-multidevice-scenario-entry` 路由），然后按移植后的指令执行。

```
/hmos-jsleak-analysis 分析这个 rawheap 快照
```

DFX 类技能接受日志与快照文件，并驱动包内的分析脚本：

```
分析 leak.rawheap，输出泄漏嫌疑对象和引用链
分析这份 cppcrash 日志，定位崩溃根因
运行 entry 模块的 Local Test 并给出覆盖率
```

---

## 技能目录

39 个技能，分 6 组，全部 model-invocable，全部出现在会话技能目录中。

### ArkTS / ArkUI 开发

| Skill | 作用 |
| --- | --- |
| `hmos-arkui-develop-skill` | 生成与修改 ArkUI 页面/组件，产出基于知识库、可编译的 `.ets` 代码。 |
| `hmos-arkts-syntax-checker` | 检查并修复 HarmonyOS 项目的 ArkTS 语法错误，自动化构建项目 |
| `hmos-arkts-deprecated-interface-checker` | 检查 HarmonyOS 项目中的废弃 SDK 接口并提供修复建议 |
| `hmos-arkts-knowledge-retriever` | Retrieve grounded ArkTS references for non-UI ArkTS work and ArkTS API usage. |
| `hmos-arkui-knowledge-retriever` | ArkUI 知识检索层，按问题语境自动路由到 ArkTS 声明式或 NDK(C-API)知识库进行精准检索，不涉及代码生成或修改 |
| `hmos-arkui-mvvm-pattern` | HarmonyOS ArkUI MVVM 架构技能 |
| `hmos-arkui-statemgt-migration` | 帮助开发者将ArkUI状态管理从V1迁移到V2 |
| `hmos-arkui-longtake-transition` | 为鸿蒙(HarmonyOS)应用添加一镜到底转场效果 |
| `hmos-design-visual-mobile` | HarmonyOS 移动端页面视觉还原技能 |

### 多设备适配

| Skill | 作用 |
| --- | --- |
| `hmos-multidevice-scenario-entry` | Entry skill for HarmonyOS multi-device adaptation. |
| `hmos-multidevice-screen-window-size` | HarmonyOS 多设备屏幕窗口尺寸适配 |
| `hmos-multidevice-fold-state` | HarmonyOS foldable-device adaptation skill for requirements, development, bug-fix, and verification phases. |
| `hmos-multidevice-avoid-areas` | Handle HarmonyOS avoid-area adaptation through a declarative scene and resource index. |
| `hmos-multidevice-interaction-methods` | HarmonyOS应用多设备交互适配开发方案skill，提供触摸、鼠标、键盘、手写笔等多输入方式的交互方案和事件归一策略 |
| `hmos-multidevice-natural-orientation` | 鸿蒙 HarmonyOS 屏幕方向与旋转相关的需求分析、开发实现、问题修复和功能验证 |
| `hmos-multidevice-hardware-access` | Handle HarmonyOS hardware-capability adaptation through a declarative scene and resource index. |

### 元服务 / ASCF

| Skill | 作用 |
| --- | --- |
| `hmos-atomicservice-assistant` | 辅助鸿蒙开发者构建元服务（Atomic Service / 免安装应用） |
| `hmos-ascf-assistant` | 辅助开发者使用 ASCF 工具链开发 HarmonyOS 元服务 |
| `hmos-ascf-convert-taro` | 辅助开发者将 Taro 项目适配（转换）为 ASCF 元服务 |
| `hmos-ascf-convert-uniapp` | 辅助开发者将 uni-app 项目适配(转换)为 ASCF 元服务 |

### Kit 接入

| Skill | 作用 |
| --- | --- |
| `hmos-push-kit` | 华为 Push Kit 推送服务集成助手（Master Skill / 大路由） |
| `hmos-push-kit-token` | Push Token 获取助手，可作为单独接入能力使用 |
| `hmos-push-kit-notification` | 通知消息助手：推送通知、消息提醒、通知样式与点击动作。 |
| `hmos-push-kit-voip` | 应用内通话（VOIP）推送助手：语音/视频来电通知与呼叫接听界面。 |
| `hmos-push-kit-background` | 后台消息推送助手：数据静默更新与消息缓存。 |
| `hmos-scan-kit-defaultscan` | 帮助开发者快速接入华为 Scan Kit 默认界面扫码能力，在不需要完全自定义相机界面、闪光灯控制、变焦、对焦等高级功能时优先使用 |
| `hmos-scan-kit-customscan` | 帮助开发者快速接入华为 Scan Kit 自定义界面扫码能力，仅在需要支持完全自定义相机预览流 UI 界面、闪光灯控制、变焦、对焦等功能的场景使用 |
| `hmos-account-kit-quicklogin-client` | 基于 HarmonyOS Account Kit 提供华为账号一键登录客户端接入指引，实现获取匿名手机号接口与华为账号一键登录组件集成 |
| `hmos-live-view-kit-build-location` | HarmonyOS实况窗（LiveView）代码生成助手，支持创建、更新、停止实况窗 |

### 测试

| Skill | 作用 |
| --- | --- |
| `hmos-local-test` | 在 HarmonyOS 应用/服务开发中执行模块的 Local Test（ArkTS/JS 单元测试），支持运行、覆盖率统计等模式，并可指定测试范围（模块、测试套件、单个用例） |
| `hmos-instrument-test` | 在 HarmonyOS 应用/服务开发中执行模块的 Instrument Test（包括 ArkTS/JS 和 C++ 测试），支持运行、覆盖率统计、ASan 检测等模式，并可指定测试范围（模块、测试套件、单个用例） |

### DFX 故障分析

| Skill | 作用 |
| --- | --- |
| `hmos-apifault-analysis` | 定位 API 调用失败、错误码与 crash/freeze 日志根因，输出结构化诊断报告。 |
| `hmos-appfreeze-analysis` | DFX Skills，自动分析 HarmonyOS / OpenHarmony Freeze（冻屏/卡死）故障日志，定位根因并输出完整证据链 |
| `hmos-jscrash-analysis` | 分析 JS Crash（ArkTS/JS 闪退）faultlogger 日志并定位根因。 |
| `hmos-cppcrash-analysis` | 分析 CppCrash（Native 层崩溃）日志：信号、寄存器、Native 调用栈与符号。 |
| `hmos-fdleak-analysis` | 分析 FD / 句柄泄漏日志并定位泄漏申请栈。 |
| `hmos-jsleak-analysis` | DFX Skills，分析 HarmonyOS/ArkTS rawheap、heapsnapshot 和 Heap Cluster 报告，识别疑似 JS 内存泄漏 |
| `hmos-native-memleak-analysis` | 基于 sample、smaps、profiler 火焰图分析 Native 内存泄漏。 |
| `hmos-memleak-analysis` | 静态分析 ArkTS、JS、C/C++ 源码中的内存泄漏。 |

---

## 工作原理

整个包就是一个 Cordis 插件。

```
cordis.patch.yml ──insert──▶ dsh-hmos-skills  (lib/index.js)
                                   │  ctx.skills.registerProvider()
                                   ▼
                         @deepseek-ai/dsh-skill   ◀── @deepseek-ai/dsh-tool-skill
                         （合并后的技能注册表）        （会话技能目录 + `skill` 工具）
                                   ▲
                              skills/*/SKILL.md   （39 个技能包，在本仓库内）
```

* **单个 provider，rank 600。** `lib/index.js` 以 `BUNDLED_SKILL_RANK` 在
  `ctx.skills` 上注册名为 `hmos` 的 provider。因此项目内
  `<project>/.dsh/skills`（rank 100）或用户目录 `~/.dsh/skills`（rank 400）
  的同名技能依然优先 —— **你本地的修改永远覆盖本包**。
* **发现即目录扫描。** `list()` 读取 `skills/*/SKILL.md`、解析 frontmatter 并返回
  候选；`get()` 每次加载都重新读文件，改技能正文下一次加载即生效，没有需要失效的缓存。
* **运行时零依赖。** frontmatter 由一个约 120 行的 YAML 子集解析器处理，正好覆盖本
  语料用到的构造（普通标量、引号标量、`|` / `>` 块标量、嵌套 `metadata` 映射）。
  已验证：39 个文件的解析结果与 `yaml` 官方实现完全一致。
* **资源按磁盘解析。** 每个候选都带一个目录型 `resourceBase`，技能里的
  `references/`、`assets/`、`scripts/` 路径都相对它自己的安装目录解析。
* **不能有 `export default`。** Cordis loader 用 `exports.default ?? exports` 归一化插件
  模块，所以默认导出会**顶替**模块命名空间、丢掉具名 `inject`；该行随后会以「没有服务
  声明」的形态挂载，导致 DSH 启动直接失败：`cannot get property "skills" without inject`。
  因此 `lib/index.js` **只用具名导出**（与官方 `dsh-skill-badge` 一致），并且
  `scripts/smoke.mjs` 第一项就断言这个形状。

## 移植过程中改了什么

上游是 Claude Code 内容，要变成真正的 DSH 技能，改了七处。

| # | 改动 | 原因 |
| --- | --- | --- |
| 1 | **39 个技能包的 frontmatter 全部规范化** | DSH 要求 `name` + `description`；上游还在顶层带 `license`、`compatibility`、`version`、`category`。这些被收进 `metadata`，键集按固定顺序重新输出。 |
| 2 | **9 个描述裁到目录 500 字符上限内** | `dsh-tool-skill` 按 `catalogDescriptionMaxLength`（默认 500）截断目录描述并加 `...`。`hmos-push-kit` 原描述 994 字符，被截掉的正好是决定加载哪个子技能的路由表。裁剪后的文本保留了全部触发词与路由规则，完整原文仍在技能正文里。 |
| 3 | **`hmos-push-kit` 子技能拍平** | 上游把 4 个子技能嵌在 `hmos-push-kit/` 下，而 DSH 发现只深入一层（`<root>/<name>/SKILL.md`）。子技能现在是同级目录，各自带一份 `references/push-error-codes.md`，相对链接可解析。 |
| 4 | **`${SKILL_DIR}` 在加载时解析** | 上游在 3 个技能里混用 `{skill_dir}` / `$SKILL_DIR` / `${SKILL_DIR}`。移植时统一写法，provider 在正文加载时替换为真实绝对路径。 |
| 5 | **Claude Code 工具名映射** | `Glob`/`Grep`/`Read`/`Write`/`Edit`/`SearchReplace`/`Bash`/`TodoWrite`/`Task`/`WebSearch`/`WebFetch` → `glob`/`grep`/`read`/`write`/`edit`/`pwsh`/`todo_write`/`subagent`/`web_search`/`web_fetch`。字面工具名会产生误导的地方做了文件内改写，同时在每个加载的正文前注入一段运行环境说明。 |
| 6 | **去掉 CodeGenie MCP 依赖** | `hmos-arkts-syntax-checker`、`hmos-arkts-deprecated-interface-checker`、`hmos-account-kit-quicklogin-client` 和 Scan Kit 系列的整个流程都建立在 DevEco Studio 的 CodeGenie MCP 工具之上（`mcp_codegenie-mcp_check_ets_files`、`mcp_codegenie-mcp_build_project`、`builtin_*`），这些在 DevEco 之外并不存在。每个都给了明确的 DSH 替代路径 —— 用 `pwsh` 驱动 `hvigorw`，或退化为包内知识检索与 lint 工具，并明确说明未做真实编译 —— 同时同步更新了它们的流程图、决策树、检查清单与工具表。`hmos-apifault-analysis/references/tool_mapping.md` 整篇按 DSH 重写。 |
| 7 | **`.claude/skills` → `.dsh/skills`** | `hmos-multidevice-scenario-entry` 的远端加载文档与 `remote_load.sh` 描述的是 Claude Code 的工作区布局；现在 `dsh` 是该安装器的一等平台。评测用例中列出 `allowed_tools` 的夹具也改成了 DSH 工具名。 |

约 2300 个文件里其余内容**未作改动**：正文、references、assets、scripts 与上游
逐字节一致，差别仅限上表所列。

## 前置条件

技能开箱即可用于阅读、规划与代码生成。部分能力需要本机鸿蒙工具链，移植后的正文会
**明确说明**这一点，而不是假装可用：

| 能力 | 依赖 |
| --- | --- |
| 构建 / 编译（`hmos-arkts-syntax-checker`、`hmos-account-kit-quicklogin-client`、Scan Kit） | DevEco Studio，已配置 `DEVECO_SDK_HOME`，工程根目录有 `hvigorw` |
| Local / Instrument 测试 | `hdc`（真机或模拟器）、DevEco Studio |
| DFX 日志分析（`*-analysis` 系列） | Python 3 运行包内解析脚本；`heap_cluster` 需要 Node 22.5+（建议 24） |
| JS 泄漏聚类 | 在 `skills/hmos-jsleak-analysis/scripts/node/` 执行 `pnpm install`（lockfile 已包含） |
| ArkTS lint 工具 | 在 `skills/hmos-arkts-knowledge-retriever/linter-cli/` 执行 `npm ci` |

## 配置

全部可选，均有可用默认值：

```yaml
- insert:
    - id: hmos-skills
      name: 'dsh-hmos-skills'
      config:
        providerName: hmos      # 注册到 ctx.skills 的 provider 名
        environmentNote: true   # 每次加载是否注入 DSH 运行环境说明
        skillsDir: /abs/path    # 改为提供其它技能根目录
        rank: 600               # 同名技能优先级（越小越优先）
        source: bundled         # 提示词中可见的来源分类
```

设 `environmentNote: false` 可完全按上游原文提供技能内容。

## 验证

```sh
node scripts/smoke.mjs
```

通过本包 provider 列出全部技能，并断言注册表所强制的不变量：kebab-case 名称、
名称唯一、描述非空且不超过目录上限、model-invocable、目录型 resourceBase、正文
非空、已注入运行环境说明，以及**没有未解析的 `${SKILL_DIR}`** —— 最后一项在关闭
运行环境说明的情况下检查，确保占位符是在技能正文里被解析的，而不是只靠注入文本。

## 仓库结构

```
dsh-hmos-skills/
├── cordis.patch.yml       # dsh.bundle.patch：唯一一行插件挂载
├── package.json           # dsh.bundle.patch -> ./cordis.patch.yml
├── lib/
│   ├── index.js           # provider（零依赖）
│   └── types/index.d.ts
├── scripts/smoke.mjs      # 独立验证脚本
└── skills/                # 39 个技能包，一目录一个
    ├── hmos-arkts-syntax-checker/
    │   ├── SKILL.md
    │   └── references/
    ├── hmos-jsleak-analysis/
    │   ├── SKILL.md
    │   ├── references/
    │   └── scripts/       # rawheap 转换器、Node 版 heap-cluster 源码
    └── …
```

## 仓库体积

本仓库约 267 MB，因为 DFX 与知识库类技能自带真实工具链：`llvm-objdump` /
`llvm-addr2line` 符号化工具、`trace_streamer`、`rawheap_translator`、鸿蒙设计字体，
以及 ArkTS / ArkUI 知识库。

有两处**刻意未提交**：

| 未提交内容 | 体积 | 获取方式 |
| --- | --- | --- |
| `skills/hmos-jsleak-analysis/scripts/{windows,linux,macos}/heap_cluster*` | 423 MB | 这些文件每一个都超过 GitHub 单文件 100 MB 硬上限。官方文档指定的主路径是 Node 源码版 `scripts/node/heap_cluster.js`，**已包含在本仓库中** —— 在 `scripts/node/` 执行 `pnpm install` 即可使用。 |
| `skills/hmos-arkts-knowledge-retriever/linter-cli/node_modules/` | 45 MB | 在 `linter-cli/` 执行 `npm ci` 恢复；`package-lock.json` 已提交。 |

## 来源与许可

`skills/` 下的技能内容来自鸿蒙官方 Agent Skills 集合，由华为 / OpenHarmony 社区
发布（公开镜像见 AtomGit 的 `test-oh-skills/*`，文中也以 DFX Skills、
HarmonyOS 多设备技能集等名义出现）。版权归原作者所有；每个 `SKILL.md` 中的
`metadata.author` / `metadata.version` 均原样保留。

插件代码 —— `lib/`、`scripts/`、`cordis.patch.yml`、`package.json` —— 采用 MIT
许可（见 [LICENSE](LICENSE)）。

如果你是权利人并希望调整或下架本移植版本，请开 issue。
