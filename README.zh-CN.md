# pi-apply-patch-plus

[English](README.md) | [简体中文](README.zh-CN.md)

给 [pi](https://github.com/earendil-works/pi) 带来 **Codex 风格补丁式编辑**：用一份结构化补丁（`apply_patch`）一次完成多个文件的增、改、删、移，配合本地格式校验与彩色 diff 预览。智能识别 GPT 系列模型，自动启用补丁式编辑并接管 `edit` / `write`，无需维护模型清单。

## 特性

- **补丁式多文件编辑** —— 一个补丁信封描述所有改动，改动一目了然：

  ```text
  *** Begin Patch
  *** Add File: src/new.ts
  +export const value = 1;

  *** Update File: src/app.ts
  @@
  -const oldValue = 0;
  +const newValue = 1;

  *** Delete File: src/obsolete.ts
  *** End Patch
  ```

- **本地校验先行** —— 解析并验证补丁格式（信封、操作头、上下文匹配、`+` 前缀），不合法则拒绝执行，绝不静默产生错误结果。
- **智能 GPT 识别** —— 任何 `gpt-*` 模型自动获得该工具（`gpt-5.6-sol` / `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-4o` 及未来的 GPT 模型），无需硬编码清单；非 GPT 模型自动隐藏。
- **Codex 远程约束** —— 在 `gpt-5.2/5.3-codex` 模型上，补丁以 CFG 约束的 freeform 工具发送到 OpenAI Codex API，语法层即受限。
- **Diff UI 与实时计数** —— pi 原生 diff 渲染器显示彩色差异，逐文件展示 `+X -Y` 与操作进度。
- **中断恢复** —— 被打断的孤儿工具调用自动补上合成取消输出，后续提问不会因缺失 `custom_tool_call_output` 而失败。
- **工具接管策略** —— 启用后禁用 `edit` / `write`，统一走 `apply_patch`，避免并行工具同改一文件互相覆盖；切回非 GPT 模型时自动恢复。

## 安装

需要先安装 [pi](https://github.com/earendil-works/pi)。从 npm 安装：

```bash
pi install npm:pi-apply-patch-plus
```

然后在 pi 中输入 `/reload`，让扩展加载进当前会话。

后续更新：

```bash
pi update npm:pi-apply-patch-plus
```

其他方式 —— 从源码仓库安装：

```bash
pi install git:github.com/matsuzaka-yuki/pi-apply-patch-plus
```

本地开发：

```bash
pi install ./
```

## 工作原理

1. 在 pi 中注册 `apply_patch` 工具；
2. 按模型执行工具策略：GPT 模型启用 `apply_patch` 并移除 `edit` / `write`，非 GPT 模型恢复内置编辑工具；
3. 在 `gpt-5.2/5.3-codex` 上，工具以 `type: "custom"` + `syntax: "lark"` 的 freeform 形式发送到 Codex API，并解析 `custom_tool_call` 事件映射回 pi 工具调用；
4. 本地解析补丁 → 校验 → 应用文件改动 → 以 `custom_tool_call_output` 回传结果；
5. 全程渲染逐文件 `+X -Y` 计数与彩色 diff（展开工具输出查看完整补丁）。

## 补丁格式

信封结构：

```text
*** Begin Patch
*** Add File: hello.txt
+Hello
*** End Patch
```

支持操作：

- `*** Add File: <path>` —— 新建文件（内容逐行以 `+` 开头）
- `*** Delete File: <path>` —— 删除文件
- `*** Update File: <path>`（可选 `*** Move to: <path>`）—— 原地修改 / 改名
- hunk：`@@` 起始，行为 ` `（上下文）、`+`（新增）、`-`（删除）

路径行为与 pi 的 `write` 语义一致：相对路径基于当前工作目录解析。

## 模型支持

| 模型 | 行为 |
|------|------|
| 任意 `gpt-*`（如 `gpt-5.6-sol`、`gpt-5.6-luna`、`gpt-5.6-terra`） | 本地支持：普通 JSON 工具，补丁放在 `input` 字段 |
| `gpt-5.2-codex*` / `gpt-5.3-codex*` | 完整支持：额外以 CFG/freeform 形式走 Codex API |
| 非 GPT 模型（`claude-*`、`deepseek-*`、`glm-*` 等） | 工具隐藏并拦截 |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
```

## 致谢

本项目在功能设计与交互思路上参考了 MIT 协议开源的 [pi-extension-codex-apply-patch](https://www.npmjs.com/package/pi-extension-codex-apply-patch) 项目，感谢原作者的贡献。在此基础之上，本项目重写了模型识别逻辑（智能 GPT 识别替代硬编码清单）、文档与项目包装，使其更贴合个人使用场景。
