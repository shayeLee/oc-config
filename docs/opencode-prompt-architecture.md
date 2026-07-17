# opencode 提示词系统架构

> 以当前项目 `~/.config/opencode` 下的 agent team（Architect / Coder / CodeReview / Rescue）为例，
> 说明 opencode 从 provider 基座到 agent 自定义 prompt 的完整装配链路。
> 源码版本: `anomalyco/opencode` main。

---

## 一、总览：一条 LLM 请求里有多少层 system 消息

每次 LLM 调用最终发往模型时，system 部分由 **两条独立消息** 组成：

```
┌────────────────────────────────────────────────────────────┐
│ system message #1  (独立消息)                                │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ agent prompt 或 provider 基座 prompt（二选一）          │ │
│ └────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────┤
│ system message #2  (多条 join 成一条)                       │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ ① 模型身份 + 运行环境                                    │ │
│ │ ② Instructions (AGENTS.md 等外部指令)                   │ │
│ │ ③ MCP 工具说明（如有）                                   │ │
│ │ ④ Skills 描述（SKILL.md）                                │ │
│ │ ⑤ Structured output 提示（如需要）                       │ │
│ │ ⑥ <system-reminder> (compaction 警告等，运行时注入)      │ │
│ └────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────┤
│ 工具定义 (不在 system 文本里，单独按 provider 协议注入)       │
│ user messages                                               │
└────────────────────────────────────────────────────────────┘
```

---

## 二、装配链路（源码追踪）

### 2.1 agent prompt 从何而来

`packages/opencode/src/config/agent.ts:14-19`

```typescript
export async function load(dir: string) {
  for (const item of await Glob.scan("{agent,agents}/**/*.md", { ... })) {
    const md = await ConfigMarkdown.parse(item)
    const config = {
      name,
      ...md.data,              // frontmatter → description / mode / model / permission
      prompt: md.content.trim(), // body → agent prompt
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
}
```

**关键事实**：每个 agent `.md` 文件的非 frontmatter 部分（body）即 `md.content`，被赋为 `Agent.Info.prompt`。

示例（本项目）:

| 文件 | agent.prompt |
|---|---|
| `agents/Architect.md` | 第 61–222 行（"You are the architecture lead..."） |
| `agents/Coder.md` | 第 68–133 行（"You are a pragmatic implementation subagent..."） |
| `agents/CodeReview.md` | 第 24–58 行（"You are in code review mode."） |
| `agents/Rescue.md` | 第 21–46 行（"你是「求救」子代理..."） |

### 2.2 provider 基座 prompt 怎么选

`packages/opencode/src/session/system.ts:28-45`

```typescript
export function provider(model: Provider.Model) {
  if (model.api.id.includes("muse-spark")) return [PROMPT_META]
  if (model.api.id.includes("gpt-4") || includes("o1") || includes("o3")) return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (includes("codex")) return [PROMPT_CODEX]
    return [PROMPT_GPT]           // ← gpt-5.6-terra 落这里 → gpt.txt
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.includes("kimi")) return [PROMPT_KIMI]   // ← kimi-k2.7-code → kimi.txt
  return [PROMPT_DEFAULT]         // ← 不匹配任何 → default.txt
}
```

对应的 `prompt/*.txt` 文件:

```
packages/opencode/src/session/prompt/
  anthropic.txt   beast.txt    build-switch.txt  codex.txt
  copilot-gpt-5.txt  default.txt  gemini.txt  gpt.txt
  kimi.txt  meta.txt  plan-mode.txt  plan-reminder-anthropic.txt
  plan.txt  trinity.txt
```

provider 基座 prompt 定义了开放式（没有自己 prompt 的）agent 的基础行为准则（如 `default.txt` 中的 "You are opencode, an interactive CLI tool..."，含输出风格、工具使用策略、安全约束等）。

### 2.3 基座与 agent prompt 如何二选一

`packages/opencode/src/session/llm/request.ts:58-61`

```typescript
const system = [
  ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
  ...input.system,
  ...(input.user.system ? [input.user.system] : []),
]
```

**三元表达式语义**:

- `input.agent.prompt` 有值 → 用 agent prompt 放进 system #1，`SystemPrompt.provider()` 不会被执行
- `input.agent.prompt` 无值 → 调用 `SystemPrompt.provider(model)` 选 provider 基座

因此，所有在 `~/.config/opencode/agents/` 或 `.opencode/agents/` 下定义了 `.md` 文件的自定义 agent，**provider 基座 prompt 永远不会进入它们的 context**。

### 2.4 system #2 的组成

`packages/opencode/src/session/prompt.ts:1260-1269`

```typescript
const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
  sys.skills(agent),                    // ④ Skills 描述
  sys.environment(model),               // ① 模型身份 + 运行环境
  instruction.system(),                 // ② AGENTS.md 等外部指令
  sys.mcp(agent, session.permission),   // ③ MCP 工具说明
  MessageV2.toModelMessagesEffect(...), // user messages
])

const system = [
  ...env,
  ...instructions,
  ...(mcpInstructions ? [mcpInstructions] : []),
  ...(skills ? [skills] : []),
]
```

**system #2 的注入内容**:

| 来源 | 内容 | 对谁可见 |
|---|---|---|
| ① env | "You are powered by model X", `<env>` 工作目录 / git / 平台 / 日期 | 所有 agent |
| ② instructions | opencode.json 中 `instructions` 数组引用的文件（如 AGENTS.md） | 所有 agent（按配置） |
| ③ MCP | MCP server 的工具与指令描述 | 有相应权限的 agent |
| ④ Skills | SKILL.md 描述（如 figma-restore, dws） | 所有 agent（按权限过滤器） |
| tools | 工具定义（Read, Edit, Glob, Grep, Bash, Task 等） | 所有 agent（按权限过滤器） |

---

## 三、本项目 agent team 实际装配结果

### 3.1 Architect (`openai/gpt-5.6-terra`)

```
路由: gpt-5.6-terra → gpt.txt（但永远不会用到）

system #1: Architect.md body（第 61–222 行）
  - 角色定义、Core Responsibilities
  - Information Gathering、Tool Boundaries
  - Agent Delegation（explore / general / Coder / CodeReview / Rescue）
  - Implementation Supervision
  - Iterative Work（模式闸门、Loop Specification、每轮协议、停止状态）
  - Output Style、Constraints

system #2:
  - 模型身份 + 环境
  - AGENTS.md (如果配置了 instructions)
  - Skills: figma-restore / dws
  - Tools: Read / Glob / Grep / Bash (只读 git/npm/gh) / Task / LSP / WebFetch / WebSearch / Skill

→ 行为完全由自己的 222 行 prompt 控制
```

### 3.2 Coder (`opencode-go/kimi-k2.7-code`)

```
路由: kimi-k2.7-code → kimi.txt（但永远不会用到）

system #1: Coder.md body（第 68–133 行）
  - Subagent Role、Execution Judgment
  - Core Behavior（inspect first, preserve existing style）
  - Minimal & Surgical Changes
  - Execution & Verification

system #2:
  - 模型身份 + 环境
  - Skills: figma-restore / dws
  - Tools: Read / Glob / Grep / Edit(*) / Bash(*) / Task / WebFetch

→ 行为完全由自己的 66 行 prompt 控制
```

### 3.3 CodeReview (`openai/gpt-5.6-sol`)

```
路由: gpt-5.6-sol → gpt.txt（但永远不会用到）

system #1: CodeReview.md body（第 24–58 行）
  - Default behavior（自动 git diff）
  - Review priorities（P0 安全 → P1 回归 → ...）
  - Output format（P0/P1/P2/P3 标签，文件:行引用）
  - Constraints（只审不修）

system #2:
  - 模型身份 + 环境
  - Tools: Git status/diff/log（只读 bash）

→ 行为完全由自己的 35 行 prompt 控制
```

### 3.4 Rescue (`openai/gpt-5.6-sol`)

```
路由: gpt-5.6-sol → gpt.txt（但永远不会用到）

system #1: Rescue.md body（第 21–46 行）
  - 诊断协议（理解问题 → 收集上下文 → 独立分析 → 返回诊断）
  - 返回格式（诊断结论、建议、验证方式、不确定性）
  - 约束（只读分析、不修文件、不自己搜索）

system #2:
  - 模型身份 + 环境
  - Tools: Read / Glob / Grep / WebFetch / Git status/diff/log

→ 行为完全由自己的 26 行 prompt 控制
```

---

## 四、provider 基座 prompt 何时才生效

只有**没有自己 `.md` prompt 的内置 agent** 才会走 provider 基座：

| 内置 agent | prompt 来源 |
|---|---|
| 内置 compile（compaction）| `agent/prompt/compaction.txt` |
| 内置 title | `agent/prompt/title.txt` |
| 内置 summary | `agent/prompt/summary.txt` |
| 内置 explore | `agent/prompt/explore.txt` |
| 内置 build | `agent/generate.txt` |
| 无 prompt 的自定义 agent | `SystemPrompt.provider(model)` 选基座 |

`agent/agent.ts:214-263` 直接 import 了这些内置 prompt：

```typescript
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_GENERATE from "./generate.txt"
```

---

## 五、关键结论

1. **有 prompt 的 agent 完全自主**：一旦 agent `.md` 文件存在 body，provider 基座 prompt 不会出现在 context 中。用户自控全部行为语言。

2. **基座 prompt 是兜底**：`default.txt` / `gpt.txt` / `codex.txt` 等仅对无 prompt 的 agent（内置或未写 body 的）生效。

3. **基础设施层对所有人都注入**：system #2 的 env / instructions / skills / tools 不受 agent prompt 是否存在的影响。

4. **子代理继承自己的 prompt，不继承主代理的**：Architect 调用 Coder 时，Coder 的 context 只有 Coder.md body + system #2，不会混入 Architect.md 的内容。
