# dsh-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 加两层跨 session 持久记忆：
**用户层**（跨所有项目）和**项目层**（按 git 仓库根分桶）。记忆是纯 Markdown 文件，自动注入 system prompt，
在对话里说「记忆一下」就会写进去。

> Layered persistent memory for DeepSeek Harness. Markdown files, injected into the system prompt, written by the model on natural-language request.

---

## 前置条件

- dsh 0.2.x（Desktop 版或 CLI 版均可）
- 不需要额外依赖：插件不声明运行时依赖，`defineTool` / `schemastery` 从运行中的 dsh 安装锚点解析

## 安装

**Desktop 版（推荐）**：设置 → 插件 → 从本地目录安装，选这个目录；或用内置 CLI：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add link:"$PWD"
```

**CLI 版**：

```bash
dsh plugin --profile web add git+https://github.com/ianzheng001/dsh-memory.git
```

> `git+` 前缀不能省，否则 pnpm 会把 URL 当成 tarball 下载。

装完**重启一次 App**（Host 半插件没有热更新）。

验证是否装上：

```bash
dsh --profile desktop --dump-config | grep -A2 "id: memory"
```

## 怎么用

不需要记命令，直接说：

| 你说 | 效果 |
|---|---|
| 「记一下：这个项目用 pnpm」 | 写入**项目层**记忆 |
| 「在顶层记忆一下：结论先行」 | 写入**用户层**记忆（跨所有项目） |
| 「你记得这个项目的包管理器是什么吗」 | 模型自动调 `memory_recall` 检索 |
| 「把那条记忆删了」 | 模型调 `memory_forget` 归档（不真删） |

也可以直接让模型调工具：

- `memory_save(title, content, scope?, type?, tags?, pinned?, replace?)`
- `memory_recall(slug? | query?, scope?)`
- `memory_list(scope?)`
- `memory_forget(slug, scope?, reason?)`

记忆文件可以手改——插件每次组装 prompt 都会重新读：

```
~/.dsh/memory/
├── user/
│   ├── MEMORY.md              # 自动生成的索引
│   └── entries/*.md           # 一条记忆一个文件
├── projects/
│   └── <目录名>-<hash6>/
│       ├── .project.json      # 记录项目根路径
│       ├── MEMORY.md
│       └── entries/*.md
└── archive/                   # forget 的落点，可手工恢复
```

`$DSH_HOME` 不是 `~/.dsh` 时，记忆目录跟着走。

### 一条记忆长这样

```markdown
---
slug: zero-runtime-dependencies
title: dsh 插件必须零运行时依赖
type: constraint
scope: project
created: 2026-10-21T18:30:00+08:00
updated: 2026-10-21T18:30:00+08:00
pinned: true
tags: ["dsh", "plugin"]
supersededBy: null
---

**结论**：插件的 package.json 不写 dependencies。

**为什么**：`dsh plugin add link:` 走 pnpm link 不给包装依赖。

**怎么用**：`hostRequire('@deepseek-ai/dsh-tools')` 从 dsh 安装锚点解析。
```

`type` 取 `constraint` / `preference` / `decision` / `pitfall` / `fact` / `glossary`。
`pinned: true` 的条目每次会话都注入全文，其余只注入一行摘要。

## 配置

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: memory
  config:
    userMaxChars: 1500        # 用户层注入上限（字符）
    projectMaxChars: 2500     # 项目层注入上限
    pinnedMaxChars: 400       # 单条 pinned 全文上限
    injectIntoSubagents: false # subagent 是否注入用户层
    autoMemorize: true        # 是否允许模型自主记忆
    enabled: true
    memoryHome: ''            # 默认 $DSH_HOME/memory
```

## 和 AGENTS.md / skill / HANDOVER 的分工

| 内容 | 写哪 |
|---|---|
| 项目规范、目录约定、运行方式 | 项目 `AGENTS.md`（进 git，团队共享） |
| 可复用方法论、流程 | skill |
| 进度交接 | `HANDOVER.md` |
| **个人偏好、红线、项目决策上下文、踩过的坑** | **memory** |

插件会在 system prompt 里把这条分工讲给模型，避免 memory 长成第二个 AGENTS.md。

## 设计要点

完整设计见 [DESIGN.md](DESIGN.md)。三条关键决定：

1. **注入点是 system prompt 的 section，不是伪造的 user message**。记忆是指令语义；dsh 自己管理 system 节点的追加与压缩后重建，不需要插件监听压缩事件。
2. **只注入索引，不全量灌正文**。超预算的条目降级成一行摘要并显式告知「还有 N 条」，模型需要时再 `memory_recall`。
3. **纠错不撕历史**。`replace` 把旧条目标 `supersededBy` 并停止注入，文件保留可追溯；`memory_forget` 只移到 `archive/`，永不 `unlink`。

## 限制

- 无 Settings UI（v1.1 计划），改配置走 profile patch
- 跨进程并发写（Desktop + CLI 同时写同一条）是后写覆盖，只保证不丢文件
- 项目 key 由绝对路径 hash 决定，项目目录搬家后记忆不会自动跟过去（`.project.json` 里存了原路径，将来做 `memory reattach`）
- `memory_forget` 归档而非删除，清理 `archive/` 需手工

## 开发

```bash
npm test        # node --test 全套用例
```

结构：

```
lib/host.js         # 从 dsh 安装锚点解析 Host 模块（零运行时依赖）
lib/paths.js        # 项目根判定、项目 key、scope 目录
lib/frontmatter.js  # frontmatter 子集解析/序列化
lib/store.js        # 条目读写、原子落盘、索引重建、归档
lib/render.js       # 预算渲染
lib/protocol.js     # 注入给模型的记忆协议文本
lib/handlers.js     # 四个工具的业务逻辑（脱离 Cordis，可直接测）
lib/index.js        # 插件入口：Config / section 注册 / 工具注册
```

## License

MIT
