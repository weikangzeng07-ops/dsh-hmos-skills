---
name: "hmos-arkts-syntax-checker"
description: "检查并修复 HarmonyOS 项目的 ArkTS 语法错误，自动化构建项目。当需要编译项目、修复编译错误、生成 HAP/App 产物时使用。提供静态语法检查、错误自动修复、循环构建直到成功的完整工作流程。支持错误优先级分类（P0/P1/P2）、最大重试机制、构建产物自动定位。"
---
# HarmonyOS 项目自动化构建

## 技能概述

本技能专门用于自动化构建 HarmonyOS 项目，通过静态语法检查、错误修复和循环构建的流程，确保项目能够成功编译并生成产物。

## 使用场景

- ✅ 需要编译 HarmonyOS 项目生成 HAP/App 产物
- ✅ 项目存在语法错误需要修复
- ✅ 自动化构建流程，减少手动干预
- ✅ 持续集成/持续部署（CI/CD）场景
- ✅ 项目初次构建或升级后构建

## 工作流程

### 核心流程图

```
开始
  │
  ├─→ 步骤0: 检查 DevEco 构建工具链（hvigorw / DEVECO_SDK_HOME）
  │     ├─→ 工具链可用 → 继续执行
  │     └─→ 工具链不可用 → 退化为静态审查并注明 → 继续执行
  │
  ├─→ 步骤1: 扫描项目源文件
  │     └─→ 获取所有 .ets 文件列表
  │
  ├─→ 步骤2: 静态语法检查
  │     └─→ hvigorw 编译诊断（或包内 linter-cli）
  │
  ├─→ 步骤3: 分析诊断结果
  │     ├─→ 有错误 → 步骤4: 修复错误
  │     └─→ 无错误 → 步骤5: 构建项目
  │
  ├─→ 步骤4: 修复错误
  │     ├─→ 应用修复方案
  │     └─→ 返回步骤2（重新检查）
  │
  ├─→ 步骤5: 构建项目
  │     └─→ pwsh + hvigorw 构建
  │
  ├─→ 步骤6: 检查构建结果
  │     ├─→ 构建失败 → 分析错误 → 步骤4
  │     └─→ 构建成功 → 步骤7
  │
  └─→ 步骤7: 输出构建产物
        └─→ 完成
```

### 详细执行步骤

#### 0. 检查构建工具链依赖

**⚠️ 重要提示：本技能的检查与构建步骤依赖本机 DevEco 构建工具链**

原始版本依赖 DevEco Studio CodeGenie 的 MCP 工具，在 DeepSeek Harness 中不存在。按下表替换：

| 原 MCP 工具 | DSH 替代方式 |
| --- | --- |
| `mcp_codegenie-mcp_check_ets_files` | 无 1:1 等价物。优先用 `pwsh` 执行 `hvigorw --mode module -p module=<module>@default assembleHap`，让 ArkTS 编译器报出诊断；快速静态检查可加载 `hmos-arkts-knowledge-retriever` skill，使用其中的 `linter-cli` |
| `mcp_codegenie-mcp_build_project` | `pwsh` 执行工程根目录的 `hvigorw`（Windows: `hvigorw.bat`） |
| `mcp_codegenie-mcp_harmonyos_knowledge_search` | 加载 `hmos-arkts-knowledge-retriever` / `hmos-arkui-knowledge-retriever` skill，或使用 `web_search` |

前提：本机已安装 DevEco Studio 并配置 `DEVECO_SDK_HOME`，工程根目录存在 `hvigorw` / `hvigorw.bat`。
若工具链不可用，则退化为静态审查，并在结论中明确注明未能实际编译验证。

**确认可用的检查方式后继续执行后续步骤**。

---

#### 1. 项目分析

首先分析项目结构和配置：

**关键配置文件**：

- `build-profile.json5` - 项目级构建配置
- `entry/build-profile.json5` - 模块级构建配置
- `module.json5` - 模块配置
- `oh-package.json5` - 依赖配置

#### 2. 获取源文件列表

使用 `glob` 工具搜索项目中的 ETS 文件：

```bash
# 搜索所有 .ets 文件
**/*.ets

# 排除目录
- oh_modules/
- build/
- .preview/
```

#### 3. 执行静态语法检查

执行 ArkTS 静态语法检查（获取编译器诊断）：

```powershell
# 让 ArkTS 编译器对每个模块报出诊断
& .\hvigorw.bat --mode module -p module=entry@default assembleHap
# 需要更快、更细的静态检查时，加载 hmos-arkts-knowledge-retriever skill，
# 使用其中的 linter-cli 对 .ets 文件做单文件检查
```

**诊断信息类型**：

| 错误码        | 类型        | 说明                 | 优先级 |
| ------------- | ----------- | -------------------- | ------ |
| 28007         | Warning     | 权限警告             | P2     |
| 6133          | Warning     | 未使用的变量/符号    | P2     |
| 6387          | Information | 使用了废弃的 API     | P1     |
| addTryCatch   | Warning     | 需要异常处理         | P2     |
| addAsyncCatch | Warning     | 异步函数需要异常处理 | P2     |
| 其他          | Error       | 语法错误/类型错误    | P0     |

#### 4. 错误修复策略

根据错误类型采取不同的修复策略：

**P0 - 必须修复（阻止编译）**：

- 语法错误：缺少分号、括号不匹配
- 类型错误：类型不匹配
- 未定义的变量/函数
- 导入错误

**P1 - 强烈建议修复**：

- 废弃 API：查找替代 API，应用迁移方案

**P2 - 可选优化**：

- 未使用变量：删除或使用下划线前缀
- 异常处理：添加 try-catch

**详细修复示例**: 参考 [error-fixing-examples.md](references/error-fixing-examples.md)

#### 5. 构建项目

使用 `pwsh` 调用 `hvigorw` 构建项目：

```powershell
# HAP（测试/调试）
& .\hvigorw.bat --mode module -p module=entry@default -p buildMode=debug assembleHap
# APP（发布）
& .\hvigorw.bat --mode project -p product=default -p buildMode=release assembleApp
```

**构建目标选择**：

- `hap` - 生成单个 HAP 包（用于测试/调试）
- `app` - 生成 APP 包（用于发布）

#### 6. 构建错误处理

如果构建失败，分析错误信息：

**常见构建错误**：

1. **依赖问题**: `Error: Cannot find module '@ohos/xxx'` → 安装依赖
2. **资源问题**: `Error: Resource not found` → 检查资源文件
3. **签名问题**: `Error: Signing failed` → 检查签名配置
4. **编译错误**: `Error: ArkTS compiler error` → 返回步骤2重新检查

#### 7. 输出构建产物

构建成功后，产物位置：

```
项目根目录/
├── entry/build/default/outputs/default/entry-default-signed.hap
└── build/outputs/default/{project-name}-default-signed.app
```

**输出示例**: 参考 [output-examples.md](references/output-examples.md)

## 循环修复机制

### 决策树

```
开始构建流程
│
├─ DevEco 构建工具链可用？
│   ├─ 否 → 退化为静态审查并在结论中注明 → 继续
│   └─ 是 → 继续
│
├─ 静态检查结果？
│   ├─ 有错误 → 错误类型？
│   │   ├─ P0 语法错误 → 必须修复 → 重新检查
│   │   ├─ P1 废弃 API → 建议修复 → 重新检查
│   │   └─ P2 代码质量 → 可选修复 → 继续构建
│   │
│   └─ 无错误 → 执行构建
│
├─ 构建结果？
│   ├─ 成功 → 输出产物路径 → 完成
│   │
│   └─ 失败 → 错误类型？
│       ├─ 依赖问题 → 安装依赖 → 重新构建
│       ├─ 签名问题 → 提示手动修复 → 终止
│       ├─ 资源问题 → 检查资源文件 → 重新构建
│       └─ 编译错误 → 返回静态检查
│
└─ 重试次数 > 5？
    ├─ 是 → 终止，输出失败报告
    └─ 否 → 继续循环
```

### 最大重试次数

为避免无限循环，设置最大重试次数：

```javascript
const MAX_RETRY_COUNT = 5;
let retryCount = 0;

while (retryCount < MAX_RETRY_COUNT) {
  // 1. 静态检查
  const diagnostics = await checkEtsFiles(files);
  
  // 2. 分析错误
  const errors = filterErrors(diagnostics);
  
  if (errors.length === 0) {
    // 3. 构建项目
    const buildResult = await buildProject();
  
    if (buildResult.success) {
      return { success: true, output: buildResult.output };
    }
  } else {
    // 4. 修复错误
    await fixErrors(errors);
  }
  
  retryCount++;
}

return { success: false, error: 'Max retry count exceeded' };
```

### 错误修复优先级

每次循环按以下优先级修复：

1. **P0 错误** - 必须修复，否则无法编译
2. **P1 错误** - 强烈建议修复，可能影响功能
3. **P2 错误** - 可选优化，不影响编译

### 跳过策略

某些错误可以跳过：

- 权限警告（已正确配置权限）
- 未使用变量（不影响编译）
- 异常处理建议（可选优化）

## 执行清单

### 预检查

- [ ] **确认 DevEco 构建工具链可用（`DEVECO_SDK_HOME`、工程根目录 `hvigorw`）**
- [ ] 确认项目路径正确
- [ ] 检查 build-profile.json5 配置
- [ ] 确认 SDK 版本兼容性
- [ ] 检查依赖是否安装

### 构建流程

- [ ] 获取所有 ETS 文件列表
- [ ] 执行静态语法检查
- [ ] 分析并修复错误
- [ ] 执行构建命令
- [ ] 验证构建结果
- [ ] 输出构建产物路径

### 后处理

- [ ] 记录构建日志
- [ ] 统计修复的问题数量
- [ ] 提供构建产物信息

## 工具命令参考

### 构建与检查工具

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `pwsh` + `hvigorw` | 构建项目、获取 ArkTS 编译器诊断 | `assembleHap` / `assembleApp`，`buildMode=debug\|release` |
| `glob` | 搜索项目源文件 | 如 `**/*.ets` |
| `grep` | 在源码中检索 API 名称与错误码 | 正则表达式 |
| `web_search` / `web_fetch` | 查询 HarmonyOS 官方文档 | 关键词 / URL |
| `hmos-arkts-knowledge-retriever` skill | 包内 `linter-cli` 静态语法检查 | 见该 skill |
### 辅助工具

| 工具名称          | 用途         |
| ----------------- | ------------ |
| `glob`          | 搜索文件     |
| `read`          | 读取文件内容 |
| `write`         | 写入文件内容 |
| `edit`          | 编辑文件     |

## 最佳实践

### ✅ 推荐做法

1. **增量构建**：优先使用增量构建提高速度
2. **并行检查**：并行检查多个文件提高效率
3. **错误分类**：按优先级修复错误
4. **日志记录**：记录每次修复的内容
5. **版本控制**：修复前创建备份或提交

### ❌ 避免做法

1. 不要忽略 P0 级别错误
2. 不要无限重试（设置上限）
3. 不要跳过静态检查直接构建
4. 不要在构建过程中修改代码
5. 不要忽略构建警告

## 注意事项

- ⚠️ **本技能已移植到 DeepSeek Harness：原文中的 CodeGenie MCP 工具改用 `pwsh` + `hvigorw` 替代**
  - 需已安装 DevEco Studio 并配置 `DEVECO_SDK_HOME`
  - 工具链不可用时按静态审查执行，并在结论中注明未做实际编译验证
- ⚠️ 确保项目路径正确，避免构建错误的项目
- ⚠️ 构建前建议提交代码，以便回滚
- ⚠️ 某些错误需要手动修复，无法自动处理
- ⚠️ 构建时间取决于项目规模和复杂度
- ⚠️ 签名配置需要提前准备好证书文件

## 相关资源

### 参考文档

- [错误修复示例](references/error-fixing-examples.md) - 详细的错误修复代码示例
- [输出示例](references/output-examples.md) - 构建成功和失败的输出示例

### 外部资源

- [hvigor 构建工具](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor)
- [HarmonyOS 构建指南](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-build-app)
- [ArkTS 编译器](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-get-started)
- [HAP 包结构](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hap-package)
- [应用签名配置](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing)
