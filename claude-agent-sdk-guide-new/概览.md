> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent SDK 概览

> 使用 Claude Code 作为库构建生产级 AI 代理

代理是一个应用程序，它通过规划自己的步骤并调用读取文件、运行命令或编辑代码的工具来完成任务。Agent SDK 为您提供了与 Claude Code 相同的工具、[代理循环](/docs/zh-CN/agent-sdk/agent-loop)和上下文管理，可在 Python 和 TypeScript 中编程。

<h2 id="compare-the-agent-sdk-to-other-claude-tools">
  将 Agent SDK 与其他 Claude 工具进行比较
</h2>

Agent SDK、CLI、Client SDK 和 Managed Agents 各自满足不同的需求。使用该表格找到与您正在构建的内容相匹配的工具。

| 如果您...                        | 使用                                                                                | 原因                                               |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| 构建代理而不自己实现工具循环                | **Agent SDK**                                                                     | 一个在您自己的进程中运行代理循环的库，支持 Python 或 TypeScript。       |
| 进行交互式开发或从终端运行一次性任务            | [**Claude Code CLI**](/docs/zh-CN/overview)                                            | 终端界面，为日常交互使用而构建。                                 |
| 直接调用 API 并自己实现工具循环            | [**Client SDK**](https://platform.claude.com/docs/en/api/client-sdks)             | 直接访问 Anthropic API 而不是 Claude Code。您自己实现工具循环。    |
| 运行长期运行或异步代理，无需管理您自己的沙箱或会话基础设施 | [**Managed Agents**](https://platform.claude.com/docs/en/managed-agents/overview) | 托管 REST API，是 Agent SDK 的独立产品。Anthropic 运行代理和沙箱。 |

该 SDK 仅作为 Python 和 TypeScript 的库提供。要从另一种语言驱动相同的代理循环，请[以子进程的形式运行 CLI](/docs/zh-CN/headless)，使用 `-p` 标志和 `--output-format json`。

<h2 id="capabilities">
  功能
</h2>

这些 Claude Code 功能在 SDK 中可用：

| 功能           | 功能说明                                                   | 了解更多                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置工具         | 读取、写入、编辑文件，运行命令，搜索网络                                   | [工具参考](/docs/zh-CN/tools-reference)                                                                                                                                                               |
| Hooks        | 在代理生命周期的关键点运行自定义代码                                     | [Hooks](/docs/zh-CN/agent-sdk/hooks)                                                                                                                                                              |
| Subagents    | 生成专门的代理来处理专注的子任务                                       | [Subagents](/docs/zh-CN/agent-sdk/subagents)                                                                                                                                                      |
| MCP          | 通过 Model Context Protocol 连接外部工具和数据源                   | [MCP](/docs/zh-CN/agent-sdk/mcp)                                                                                                                                                                  |
| 权限           | 控制哪些工具自动运行，哪些需要批准                                      | [权限](/docs/zh-CN/agent-sdk/permissions)                                                                                                                                                           |
| 会话           | 在多次交换中保持上下文，稍后恢复或分叉                                    | [会话](/docs/zh-CN/agent-sdk/sessions)                                                                                                                                                              |
| Skills、命令和内存 | 从您的项目的 `.claude/` 和 `~/.claude/` 自动加载，与 Claude Code 相同 | [Skills](/docs/zh-CN/agent-sdk/skills)、[命令](/docs/zh-CN/agent-sdk/skills#commands-in-agent-sdk-sessions)、[内存](/docs/zh-CN/agent-sdk/modifying-system-prompts)、[配置加载](/docs/zh-CN/agent-sdk/claude-code-features) |
| Plugins      | 打包 skills、代理、hooks 和 MCP 服务器，并按本地路径加载它们                | [Plugins](/docs/zh-CN/agent-sdk/plugins)                                                                                                                                                          |

<h2 id="get-started">
  开始使用
</h2>

按照 [快速入门](/docs/zh-CN/agent-sdk/quickstart) 安装 SDK、设置您的 API 密钥，并构建您的第一个代理，该代理可以查找并修复现有代码中的错误。

<Note>
  除非事先获得批准，否则 Anthropic 不允许第三方开发者为其产品（包括基于 Claude Agent SDK 构建的代理）提供 claude.ai 登录或速率限制。请改用 [快速入门](/docs/zh-CN/agent-sdk/quickstart) 中描述的 API 密钥身份验证方法。
</Note>

<h2 id="changelog">
  更新日志
</h2>

查看完整的更新日志以了解 SDK 更新、bug 修复和新功能：

* **TypeScript SDK**：[查看 CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
* **Python SDK**：[查看 CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md)

<h2 id="report-bugs">
  报告 bug
</h2>

如果您在 Agent SDK 中遇到 bug 或问题：

* **TypeScript SDK**：[在 GitHub 上报告问题](https://github.com/anthropics/claude-agent-sdk-typescript/issues)
* **Python SDK**：[在 GitHub 上报告问题](https://github.com/anthropics/claude-agent-sdk-python/issues)

<h2 id="branding-guidelines">
  品牌指南
</h2>

对于集成 Claude Agent SDK 的合作伙伴，使用 Claude 品牌是可选的。在您的产品中引用 Claude 时：

**允许：**

* "Claude Agent"，首选用于下拉菜单
* "Claude"，当已在标记为"Agents"的菜单中时
* "{YourAgentName} Powered by Claude"，如果您有现有的代理名称

**不允许：**

* "Claude Code" 或 "Claude Code Agent"
* Claude Code 品牌的 ASCII 艺术或模仿 Claude Code 的视觉元素

您的产品应保持自己的品牌，不应显示为 Claude Code 或任何 Anthropic 产品。如有关于品牌合规性的问题，请联系 Anthropic [销售团队](https://www.anthropic.com/contact-sales)。

<h2 id="license-and-terms">
  许可证和条款
</h2>

Claude Agent SDK 的使用受 [Anthropic 商业服务条款](https://www.anthropic.com/legal/commercial-terms)管制，包括当您使用它为您自己的客户和最终用户提供的产品和服务时，除非特定组件或依赖项由该组件的 LICENSE 文件中指示的不同许可证覆盖。

<h2 id="next-steps">
  后续步骤
</h2>

这些资源涵盖了使用 Agent SDK 构建的更深层次的技术细节和示例项目。

* [快速入门](/docs/zh-CN/agent-sdk/quickstart)：构建你的第一个查找和修复 bug 的代理
* [迁移指南](/docs/zh-CN/agent-sdk/migration-guide)：从 Claude Code SDK 包迁移到 Agent SDK
* [Agent 循环](/docs/zh-CN/agent-sdk/agent-loop)：Claude 如何规划、调用工具以及决定任务何时完成
* [示例代理](https://github.com/anthropics/claude-agent-sdk-demos)：用于本地开发的演示应用
* [TypeScript SDK](/docs/zh-CN/agent-sdk/typescript)：完整的 TypeScript API 参考和示例
* [Python SDK](/docs/zh-CN/agent-sdk/python)：完整的 Python API 参考和示例
* [Agent 工具设计](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)：Claude Code 团队如何使用动态工作流来同时编排许多子代理
