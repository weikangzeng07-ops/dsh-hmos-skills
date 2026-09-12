# 工具映射表与适配约定

本 Skill 以「能力」描述工具调用，下表给出各环境对应的具名工具。**全局约定：下文统一用 CodeGenie 的 `builtin_*` 工具名描述；在 DeepSeek Harness 中执行时，按下表替换为对应工具。** `builtin_web_rag` 与 `builtin_check_editor_errors` 在 DSH 中无 1:1 等价物，按下方降级方案 W / E 执行。

| 能力 | CodeGenie 工具 | DSH 工具 | 说明 |
| --- | --- | --- | --- |
| 读取文件 | `builtin_read_file` | `read` | 支持分页（offset/limit）处理大文件 |
| 写入文件 | `builtin_write_file` | `write` | 创建/覆盖写入文件（诊断报告） |
| 编辑文件 | `builtin_edit_file` | `edit` | 精确替换文件中的文本 |
| glob 查找 | `builtin_glob` | `glob` | 按 glob 模式查找文件（如 `**/*.ets`） |
| 正则搜索 | `builtin_grep` | `grep` | 按正则搜索文件内容，可配合 glob 过滤 |
| 执行命令 | `builtin_execute_command` | `pwsh` | hdc/python/curl 等，**注意超时**；可加 `run_in_background: true` 跑长命令 |
| 结构化任务 | `builtin_write_todo` | `todo_write` | 创建和管理任务列表 |
| 文档 RAG | `builtin_web_rag` | **无 → 降级方案 W** | 查官方文档/ArkTS 语法/API 用法 |
| 编辑器语法检查 | `builtin_check_editor_errors` | **无 → 降级方案 E** | 检查文件语法错误与代码问题 |
| 派发子 Agent（阶段 4） | **无 → 主上下文内联执行** | `subagent` | 阶段 4 可委派 `subagent` 隔离大块原始抓取 |

## 工具选择原则

- 文件读写/搜索 → 优先用 `read` / `write` / `edit` / `glob` / `grep`
- 文档查询 → 降级方案 W
- 系统命令（hdc、python） → `pwsh`
- Gitee 代码仓原始文件 → `pwsh` + `curl`（web 检索覆盖不到时）
- 日志采集（hilog）→ 必须用 `pwsh` 跑本 skill 的 `hilog_collector.py` / `hilog -x`；**不得**用 agent 自带的日志采集工具替代。脚本产出结构化 `status`/`parsed_files`，自带工具不兼容（详见 SKILL.md 步骤5）。

## 降级方案 W — 文档查询（替代 `builtin_web_rag`）

1. `web_search` 按错误码 / API 名称 / 功能关键词检索
2. 复用本 Skill 既有的 Gitee raw 文件 `curl` 兜底（见阶段 3.2 步骤 2 / 4.2 / 4.4）
3. 命中后用 `web_fetch` 取正文要点

> 召回质量低于 CodeGenie 专属 RAG，在诊断报告「文档参考」处注明"文档来源为通用检索"。

## 降级方案 E — 语法/代码问题检查（替代 `builtin_check_editor_errors`）

1. 优先用 `pwsh` 跑项目编译器/linter：`.ts` → `tsc --noEmit`；`.ets` → hvigor lint / ohpm linter
2. 均不可用时退化为人工审查：用 `grep` 找明显语法问题（括号/分号缺失、未闭合块等）

> 在诊断报告中注明实际使用的检查器（或"人工审查"）。
