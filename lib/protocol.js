/**
 * The static memory protocol injected into every system prompt.
 *
 * Kept short on purpose: it is paid for on every request, and its only job is
 * to make the write/recall decision unambiguous. Everything about *what* is
 * stored lives in the memory tools themselves.
 */

/** Memory protocol section text. */
export function protocolText() {
  return `## 记忆协议

你有两层跨 session 的持久记忆，内容会自动注入在本协议之后。项目层按项目根目录（git 仓库根）分桶。

### 写入
- 用户说「记一下 / 记忆一下 / 记住 / 别忘了 / remember」→ 调 \`memory_save\`，默认 \`scope="project"\`。
- 用户说「在顶层记忆 / 用户级记忆 / 全局记忆 / 跨项目记住」→ 调 \`memory_save(scope="user")\`。
- 用户说「记忆一下」时，要记的通常是上一轮讨论的内容，不是这句话本身。自己提炼成「结论 / 为什么 / 怎么用」，不要把对话原文贴进去。
- 写之前先用 \`memory_recall(query=...)\` 查重；已有相关条目就用 \`replace\` 更新，不要新建重复项。

### 主动记忆（不要滥写，一次会话最多 3 条）
只有这四种情况值得主动写：用户纠正了你的做法；用户表达了稳定的偏好或红线；做了影响后续 session 的决策；踩了将来还会踩的坑且知道根因。

### 不要写进记忆
- 项目规范、目录约定、运行方式 → 写项目 AGENTS.md（进 git，团队共享）
- 可复用方法论、流程 → 写 skill
- 进度和交接 → HANDOVER.md
- 临时状态（分支名、当前任务）、大段代码、完整文档

### 读取
\`memory_list\` 列索引；\`memory_recall(slug=...)\` 读全文；\`memory_recall(query=...)\` 关键词检索；\`memory_forget\` 仅在用户明确要求删除时调用。`
}
