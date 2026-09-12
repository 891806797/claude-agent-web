> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 使用 MCP 连接外部工具

> 配置 MCP 服务器以扩展您的代理的外部工具。涵盖传输类型、大型工具集的工具搜索、身份验证和错误处理。

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/getting-started/intro) 是一个开放标准，用于将 AI 代理连接到外部工具和数据源。使用 MCP，您的代理可以查询数据库、与 Slack 和 GitHub 等 API 集成，以及连接到其他服务，而无需编写自定义工具实现。

MCP 服务器可以作为本地进程运行、通过 HTTP 连接或直接在您的 SDK 应用程序中执行。

<Note>
  本页面涵盖 Agent SDK 的 MCP 配置。要将 MCP 服务器添加到 Claude Code CLI 以便在每个项目中加载，请参阅 [MCP 安装范围](/docs/zh-CN/mcp#mcp-installation-scopes)。
</Note>

<h2 id="quickstart">
  快速开始
</h2>

此示例使用 [HTTP 传输](#http%2Fsse-servers) 连接到 [Claude Code 文档](https://code.claude.com/docs) MCP 服务器，并使用 [`allowedTools`](#allow-mcp-tools) 与通配符来允许来自服务器的所有工具。

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
prompt: "Use the docs MCP server to explain what hooks are in Claude Code",
options: {
mcpServers: {
"claude-code-docs": {
type: "http",
url: "https://code.claude.com/docs/mcp"
}
},
allowedTools: ["mcp__claude-code-docs__*"]
}
})) {
if (message.type === "result" && message.subtype === "success") {
console.log(message.result);
}
}
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "claude-code-docs": {
                  "type": "http",
                  "url": "https://code.claude.com/docs/mcp",
              }
          },
          allowed_tools=["mcp__claude-code-docs__*"],
      )

      async for message in query(
          prompt="Use the docs MCP server to explain what hooks are in Claude Code",
          options=options,
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

代理连接到文档服务器，搜索有关 hooks 的信息，并返回结果。

<h2 id="add-an-mcp-server">
  添加 MCP 服务器
</h2>

您可以在调用 `query()` 时在代码中配置 MCP 服务器，或在通过 [`settingSources`](#from-a-config-file) 加载的 `.mcp.json` 文件中配置。

<h3 id="in-code">
  在代码中
</h3>

在 `mcpServers` 选项中直接传递 MCP 服务器。此示例为 `/Users/me/projects` 启动本地文件系统 MCP 服务器。将该路径替换为您机器上的目录：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
prompt: "List files in my project",
options: {
mcpServers: {
filesystem: {
command: "npx",
args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
}
},
allowedTools: ["mcp__filesystem__*"]
}
})) {
if (message.type === "result" && message.subtype === "success") {
console.log(message.result);
}
}
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "filesystem": {
                  "command": "npx",
                  "args": [
                      "-y",
                      "@modelcontextprotocol/server-filesystem",
                      "/Users/me/projects",
                  ],
              }
          },
          allowed_tools=["mcp__filesystem__*"],
      )

      async for message in query(prompt="List files in my project", options=options):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

<h3 id="from-a-config-file">
  从配置文件
</h3>

在您的项目根目录创建一个 `.mcp.json` 文件。当启用 `project` 设置源时，该文件会被加载，默认 `query()` 选项已启用此功能。如果您显式设置 `settingSources`，请包含 `"project"` 以加载此文件。将 `/Users/me/projects` 替换为您机器上的目录：

```json theme={null}
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    }
  }
}
```

<h2 id="connection-timing">
  连接时序
</h2>

Claude Code 在启动时注册你在 `options.mcpServers` 中传递的服务器，并在第一轮等待（如果有的话）解决后发出 [init 消息](#error-handling)。如果没有 `options.mcpServers`，Claude Code 会在第一轮之前等待 2 秒以等待待处理的服务器，因此从 [settings 文件](#from-a-config-file)（如 `.mcp.json`）加载的服务器通常在初始化时显示 `pending`。当每个 `options.mcpServers` 服务器连接时，以及它是否延迟第一轮，取决于其类型：

| 服务器类型                                 | 延迟第一轮？          | 第一轮等待超时                                             |
| :------------------------------------ | :-------------- | :-------------------------------------------------- |
| stdio 服务器，或没有缓存工具列表的 HTTP/SSE 服务器     | 是，直到连接          | [`MCP_TIMEOUT`](/docs/zh-CN/env-vars)，默认 30 秒；连接在该截止时间失败 |
| 具有缓存工具列表的远程服务器，由 Claude Code 从之前的连接保存 | 否；缓存的工具从第一轮开始可用 | 无；在其第一次工具调用时连接，该延迟连接有其自己的超时                         |
| 进程内 [SDK 服务器](#sdk-mcp-servers)       | 否；从不延迟第一轮       | 无                                                   |

要在发送 init 消息之前的单独的、更早的阶段阻止启动本身：

* 将 [`MCP_CONNECTION_NONBLOCKING`](/docs/zh-CN/env-vars) 设置为 `0` 以阻止整个连接批次。Claude Code 默认将该等待上限设为 5 秒。使用 [`MCP_CONNECT_TIMEOUT_MS`](/docs/zh-CN/env-vars) 环境变量调整上限，单位为毫秒。在该截止时间仍待处理的服务器继续在后台连接。
* 在服务器的配置上设置 `alwaysLoad: true` 以使其工具在第一轮时以完整架构可用，[豁免于工具搜索延迟](/docs/zh-CN/mcp#exempt-a-server-from-deferral)。Claude Code 在启动时等待该服务器的工具，上限为相同的截止时间，而其他服务器继续在后台连接；具有缓存工具列表的远程服务器根据上表提供它们而无需连接。

具有 `init` 子类型的 `system` 消息在发出时报告每个服务器的状态；请参阅 [错误处理](#error-handling) 以读取这些状态。

<h2 id="allow-mcp-tools">
  允许 MCP 工具
</h2>

MCP 工具需要明确的权限才能让 Claude 使用它们。没有权限的情况下，Claude 会看到工具可用，但无法调用它们。

<h3 id="tool-naming-convention">
  工具命名约定
</h3>

MCP 工具遵循命名模式 `mcp__<server-name>__<tool-name>`。例如，一个名为 `"github"` 的 GitHub 服务器，其中有一个 `list_issues` 工具，会变成 `mcp__github__list_issues`。

<h3 id="auto-approve-with-allowedtools">
  使用 allowedTools 自动批准
</h3>

使用 `allowedTools` 自动批准特定的 MCP 工具，这样 Claude 就可以在没有权限提示的情况下使用它们：

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        // your servers
      },
      allowedTools: [
        "mcp__github__*", // All tools from the github server
        "mcp__db__query", // Only the query tool from db server
        "mcp__slack__send_message" // Only send_message from slack server
      ]
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          # your servers
      },
      allowed_tools=[
          "mcp__github__*",  # All tools from the github server
          "mcp__db__query",  # Only the query tool from db server
          "mcp__slack__send_message",  # Only send_message from slack server
      ],
  )
  ```
</CodeGroup>

通配符（`*`）让你可以允许来自一个服务器的所有工具，而无需逐个列出。

<Note>
  **对于 MCP 访问，优先使用 `allowedTools` 而不是权限模式。** `permissionMode: "acceptEdits"` 不会自动批准 MCP 工具（仅限文件编辑和文件系统 Bash 命令）。`permissionMode: "bypassPermissions"` 会自动批准 MCP 工具，但也会禁用大多数其他安全提示，这比必要的范围更广；请参阅 [权限如何被评估](/docs/zh-CN/agent-sdk/permissions#how-permissions-are-evaluated) 了解保留的提示。`allowedTools` 中的通配符仅授予你想要的 MCP 服务器，不会授予其他任何东西。请参阅 [权限模式](/docs/zh-CN/agent-sdk/permissions#permission-modes) 了解完整的比较。
</Note>

<h3 id="discover-available-tools">
  发现可用工具
</h3>

要查看 MCP 服务器提供的工具，请检查服务器的文档或检查 `system` init 消息中的 `tools` 数组。MCP 工具名称以 `mcp__` 开头。

Claude Code 在 [首次连接等待](#connection-timing) 之后为在 `options.mcpServers` 中传递的服务器发出 init 消息，因此 `tools` 数组列出了到那时已连接的每个服务器的 `mcp__` 工具，以及具有 [缓存工具列表](#connection-timing) 的服务器的工具，这些服务器在首次使用时连接。任何其他尚未连接的服务器的工具不存在；请参阅 [错误处理](#error-handling) 了解如何读取每个服务器的状态。

此过滤器打印 MCP 工具名称：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

const options = {
mcpServers: {
// your servers
},
};

for await (const message of query({ prompt: "...", options })) {
if (message.type === "system" && message.subtype === "init") {
const mcpTools = message.tools.filter((name) => name.startsWith("mcp__"));
console.log("Available MCP tools:", mcpTools);
}
}
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              # your servers
          },
      )
      async for message in query(prompt="...", options=options):
          if isinstance(message, SystemMessage) and message.subtype == "init":
              mcp_tools = [t for t in message.data.get("tools", []) if t.startswith("mcp__")]
              print("Available MCP tools:", mcp_tools)


  asyncio.run(main())
  ```
</CodeGroup>

你也可以要求 Claude 列出来自服务器的可用工具。

<h2 id="transport-types">
  传输类型
</h2>

MCP 服务器使用不同的传输协议与您的代理进行通信。检查服务器的文档以查看它支持哪种传输：

* 如果文档给您一个**要运行的命令**（如 `npx @modelcontextprotocol/server-filesystem`），请使用 stdio
* 如果文档给您一个 **URL**，请使用 HTTP 或 SSE
* 如果您在代码中构建自己的工具，请使用 SDK MCP 服务器

<h3 id="stdio-servers">
  stdio 服务器
</h3>

通过 stdin/stdout 进行通信的本地进程。对于在同一台机器上运行的 MCP 服务器，请使用此方法。对于 `.mcp.json` 形式，请使用 [From a config file](#from-a-config-file) 中显示的相同字段。在代码中，传递命令及其参数。将 `/Users/me/projects` 替换为您机器上的目录：

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
        }
      },
      allowedTools: ["mcp__filesystem__read_file", "mcp__filesystem__list_directory"]
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          "filesystem": {
              "command": "npx",
              "args": [
                  "-y",
                  "@modelcontextprotocol/server-filesystem",
                  "/Users/me/projects",
              ],
          }
      },
      allowed_tools=["mcp__filesystem__read_file", "mcp__filesystem__list_directory"],
  )
  ```
</CodeGroup>

<h3 id="http/sse-servers">
  HTTP/SSE 服务器
</h3>

对于云托管的 MCP 服务器和远程 API，请使用 HTTP 或 SSE。对于 `.mcp.json` 形式，请使用 [HTTP headers for remote servers](#http-headers-for-remote-servers) 中示例的相同字段，对于 SSE 服务器使用 `"type": "sse"`。在代码中，传递服务器的 URL：

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        "remote-api": {
          type: "sse",
          url: "https://api.example.com/mcp/sse",
          headers: {
            Authorization: `Bearer ${process.env.API_TOKEN}`
          }
        }
      },
      allowedTools: ["mcp__remote-api__*"]
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          "remote-api": {
              "type": "sse",
              "url": "https://api.example.com/mcp/sse",
              "headers": {"Authorization": f"Bearer {os.environ['API_TOKEN']}"},
          }
      },
      allowed_tools=["mcp__remote-api__*"],
  )
  ```
</CodeGroup>

对于可流式传输的 HTTP 传输，请改用 `"type": "http"`。在 `.mcp.json` 和其他 JSON 配置文件中，`"streamable-http"` 被接受为 `"http"` 的别名。SDK 的 `McpHttpServerConfig` 类型仅声明 `"http"`，因此对于您在代码中传递的服务器，请使用 `"http"`。

<h3 id="sdk-mcp-servers">
  SDK MCP 服务器
</h3>

直接在您的应用程序代码中定义自定义工具，而不是运行单独的服务器进程。有关实现详情，请参阅 [custom tools guide](/docs/zh-CN/agent-sdk/custom-tools)。

由 [`initialize` control request](/docs/zh-CN/agent-sdk/typescript#sdkcontrolinitializeresponse) 注册的 SDK MCP 服务器在 Claude Code 处理请求后立即开始连接。

<h2 id="mcp-tool-search">
  MCP 工具搜索
</h2>

当你配置了许多 MCP 工具时，工具定义可能会消耗上下文窗口的很大一部分。工具搜索通过从上下文中隐藏工具定义并仅加载 Claude 每轮所需的工具来解决这个问题。

工具搜索默认启用。有关配置选项、最佳实践以及将工具搜索与自定义 SDK 工具一起使用的信息，请参阅[工具搜索](/docs/zh-CN/agent-sdk/tool-search)。

<h2 id="authentication">
  身份验证
</h2>

大多数 MCP 服务器需要身份验证才能访问外部服务。通过服务器配置中的环境变量传递凭证。

<h3 id="pass-credentials-via-environment-variables">
  通过环境变量传递凭证
</h3>

使用 `env` 字段将 API 密钥、令牌和其他凭证传递给 MCP 服务器：

<Tabs>
  <Tab title="In code">
    <CodeGroup>
      ```typescript TypeScript hidelines={1,-1} theme={null}
      const _ = {
        options: {
          mcpServers: {
            "api-server": {
              command: "npx",
              args: ["-y", "@your-org/api-mcp-server"],
              env: {
                API_KEY: process.env.API_KEY
              }
            }
          },
          allowedTools: ["mcp__api-server__*"]
        }
      };
      ```

      ```python Python theme={null}
      options = ClaudeAgentOptions(
          mcp_servers={
              "api-server": {
                  "command": "npx",
                  "args": ["-y", "@your-org/api-mcp-server"],
                  "env": {"API_KEY": os.environ["API_KEY"]},
              }
          },
          allowed_tools=["mcp__api-server__*"],
      )
      ```
    </CodeGroup>
  </Tab>

  <Tab title=".mcp.json">
    ```json theme={null}
    {
      "mcpServers": {
        "api-server": {
          "command": "npx",
          "args": ["-y", "@your-org/api-mcp-server"],
          "env": {
            "API_KEY": "${API_KEY}"
          }
        }
      }
    }
    ```

    `${API_KEY}` 语法在运行时展开环境变量。
  </Tab>
</Tabs>

<h3 id="http-headers-for-remote-servers">
  远程服务器的 HTTP 头
</h3>

对于 HTTP 和 SSE 服务器，直接在服务器配置中传递身份验证头：

<Tabs>
  <Tab title="In code">
    <CodeGroup>
      ```typescript TypeScript hidelines={1,-1} theme={null}
      const _ = {
        options: {
          mcpServers: {
            "secure-api": {
              type: "http",
              url: "https://api.example.com/mcp",
              headers: {
                Authorization: `Bearer ${process.env.API_TOKEN}`
              }
            }
          },
          allowedTools: ["mcp__secure-api__*"]
        }
      };
      ```

      ```python Python theme={null}
      options = ClaudeAgentOptions(
          mcp_servers={
              "secure-api": {
                  "type": "http",
                  "url": "https://api.example.com/mcp",
                  "headers": {"Authorization": f"Bearer {os.environ['API_TOKEN']}"},
              }
          },
          allowed_tools=["mcp__secure-api__*"],
      )
      ```
    </CodeGroup>
  </Tab>

  <Tab title=".mcp.json">
    ```json theme={null}
    {
      "mcpServers": {
        "secure-api": {
          "type": "http",
          "url": "https://api.example.com/mcp",
          "headers": {
            "Authorization": "Bearer ${API_TOKEN}"
          }
        }
      }
    }
    ```

    `${API_TOKEN}` 语法在运行时展开环境变量。
  </Tab>
</Tabs>

有关使用头进行身份验证的远程服务器的完整工作示例，请参阅[从存储库列出问题](#list-issues-from-a-repository)。

<h3 id="oauth2-authentication">
  OAuth2 身份验证
</h3>

[MCP 规范支持 OAuth 2.1](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization) 用于授权。SDK 不会打开浏览器或运行交互式 OAuth 流程。当配置的服务器返回授权质询且没有可用的存储令牌时，代理运行将继续而不使用该服务器的工具，服务器报告状态为 `needs-auth`。[系统初始化消息](/docs/zh-CN/agent-sdk/typescript#sdksystemmessage)的 `mcp_servers` 数组在发出时可能仍会为该服务器显示 `pending`。要确认服务器是否需要凭证，请在 TypeScript SDK 中轮询 `mcpServerStatus()` 或在 Python 中轮询 [`get_mcp_status()`](/docs/zh-CN/agent-sdk/python#methods)。

要提供凭证，请在您自己的应用程序中完成 OAuth 流程，并在服务器的 `headers` 中传递生成的访问令牌：

<CodeGroup>
  ```typescript TypeScript theme={null}
  // After completing OAuth flow in your app.
  // Implement getAccessTokenFromOAuthFlow for your OAuth provider.
  const accessToken = await getAccessTokenFromOAuthFlow();

const options = {
mcpServers: {
"oauth-api": {
type: "http",
url: "https://api.example.com/mcp",
headers: {
Authorization: `Bearer ${accessToken}`
}
}
},
allowedTools: ["mcp__oauth-api__*"]
};
  ```

  ```python Python theme={null}
  # After completing OAuth flow in your app.
  # Implement get_access_token_from_oauth_flow for your OAuth provider.
  access_token = await get_access_token_from_oauth_flow()

  options = ClaudeAgentOptions(
      mcp_servers={
          "oauth-api": {
              "type": "http",
              "url": "https://api.example.com/mcp",
              "headers": {"Authorization": f"Bearer {access_token}"},
          }
      },
      allowed_tools=["mcp__oauth-api__*"],
  )
  ```
</CodeGroup>

<h2 id="examples">
  示例
</h2>

<h3 id="list-issues-from-a-repository">
  从仓库列出问题
</h3>

此示例连接到远程 [GitHub MCP 服务器](https://github.com/github/github-mcp-server)以列出最近的问题。该示例包括调试日志以验证 MCP 连接和工具调用。

运行前，创建一个具有对要查询的仓库的读取访问权限的 [GitHub 个人访问令牌](https://github.com/settings/personal-access-tokens)，并将其设置为环境变量：

```bash theme={null}
export GITHUB_TOKEN=YOUR_GITHUB_PAT
```

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
prompt: "List the 3 most recent issues in anthropics/claude-code",
options: {
mcpServers: {
github: {
type: "http",
url: "https://api.githubcopilot.com/mcp/",
headers: {
Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
}
}
},
allowedTools: ["mcp__github__list_issues"]
}
})) {
// Verify MCP server connected successfully
if (message.type === "system" && message.subtype === "init") {
console.log("MCP servers:", message.mcp_servers);
}

    // Log when Claude calls an MCP tool
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name.startsWith("mcp__")) {
          console.log("MCP tool called:", block.name);
        }
      }
    }

    // Print the final result
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
}
  ```

  ```python Python theme={null}
  import asyncio
  import os
  from claude_agent_sdk import (
      query,
      ClaudeAgentOptions,
      ResultMessage,
      SystemMessage,
      AssistantMessage,
  )


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "github": {
                  "type": "http",
                  "url": "https://api.githubcopilot.com/mcp/",
                  "headers": {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"},
              }
          },
          allowed_tools=["mcp__github__list_issues"],
      )

      async for message in query(
          prompt="List the 3 most recent issues in anthropics/claude-code",
          options=options,
      ):
          # Verify MCP server connected successfully
          if isinstance(message, SystemMessage) and message.subtype == "init":
              print("MCP servers:", message.data.get("mcp_servers"))

          # Log when Claude calls an MCP tool
          if isinstance(message, AssistantMessage):
              for block in message.content:
                  if hasattr(block, "name") and block.name.startswith("mcp__"):
                      print("MCP tool called:", block.name)

          # Print the final result
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

在 `MCP servers:` 行中，`github` 的 `status` 为 `connected` 确认令牌有效。如果 Claude Code 对服务器有 [缓存的工具列表](#connection-timing)，状态可以改为 `pending`，服务器在首次工具调用时连接。如果状态为 `failed` 或 `needs-auth`，在信任结果之前请参阅 [错误处理](#error-handling)，因为当服务器不可用时 Claude 可能会回退到内置工具。

<h3 id="query-a-database">
  查询数据库
</h3>

此示例使用 [DBHub](https://github.com/bytebase/dbhub) 查询 Postgres 数据库。代理自动发现数据库架构、编写 SQL 查询并返回结果。

DBHub 的 `execute_sql` 工具运行代理发出的任何 SQL，包括写入操作，除非您限制它。在 [DBHub 配置文件](https://dbhub.ai/config/toml) 中设置 `readonly = true` 会使 DBHub 拒绝 `INSERT`、`UPDATE`、`DELETE` 和 DDL 语句，因此即使代理发出写入操作，该示例也无法修改您的数据。DBHub 在加载配置时从进程环境解析 `${DATABASE_URL}`，因此连接字符串保持在文件之外。在脚本旁边创建此 `dbhub.toml`：

```toml dbhub.toml theme={null}
[[sources]]
id = "production"
dsn = "${DATABASE_URL}"

[[tools]]
name = "execute_sql"
source = "production"
readonly = true
```

脚本随后指向 DBHub 的配置文件，而不是直接传递连接字符串。运行前，将 `DATABASE_URL` 环境变量设置为您的连接字符串。用您自己的数据库详细信息替换占位符值：

```bash theme={null}
export DATABASE_URL=postgresql://user:password@localhost:5432/mydb
```

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
// Natural language query - Claude writes the SQL
prompt: "How many users signed up last week? Break it down by day.",
options: {
mcpServers: {
postgres: {
command: "npx",
// dbhub.toml sets readonly = true, so execute_sql rejects writes
args: ["-y", "@bytebase/dbhub", "--config", "dbhub.toml"]
}
},
allowedTools: ["mcp__postgres__execute_sql"]
}
})) {
if (message.type === "result" && message.subtype === "success") {
console.log(message.result);
}
}
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage


  async def main():
      options = ClaudeAgentOptions(
          mcp_servers={
              "postgres": {
                  "command": "npx",
                  # dbhub.toml sets readonly = true, so execute_sql rejects writes
                  "args": [
                      "-y",
                      "@bytebase/dbhub",
                      "--config",
                      "dbhub.toml",
                  ],
              }
          },
          allowed_tools=["mcp__postgres__execute_sql"],
      )

      # Natural language query - Claude writes the SQL
      async for message in query(
          prompt="How many users signed up last week? Break it down by day.",
          options=options,
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

<h2 id="error-handling">
  错误处理
</h2>

MCP 服务器可能因各种原因连接失败：服务器进程可能未安装、凭证可能无效，或远程服务器可能无法访问。

Claude Code 在每个查询开始时发出一条 `system` 类型、子类型为 `init` 的消息。此消息包括每个 MCP 服务器的连接状态。`status` 字段可以是 `"pending"`、`"connected"`、`"failed"`、`"needs-auth"` 或 `"disabled"`。Claude Code 在 [首次转换连接等待](#connection-timing) 之后为在 `options.mcpServers` 中传递的服务器发出 init 消息，因此在等待时间内连接的服务器会显示 `"connected"`。

在 init 消息中，不要将 `"pending"` 本身视为失败。它可能意味着以下任何一种情况：

* 服务器尚未连接。请参阅 [Claude Code 在首次转换前等待多长时间](#connection-timing)
* 服务器的工具列表是 [从缓存提供的](#connection-timing)，连接在首次使用时建立
* 连接截止时间已过期。此类服务器根据时间报告 `"pending"` 或 `"failed"`

检查 `"failed"` 或 `"needs-auth"` 以检测无法使用的服务器：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

try {
for await (const message of query({
prompt: "Process data",
options: {
mcpServers: {
// Replace dataServer with your server configuration
"data-processor": dataServer
}
}
})) {
if (message.type === "system" && message.subtype === "init") {
const unavailableServers = message.mcp_servers.filter(
(s) => s.status === "failed" || s.status === "needs-auth"
);

        if (unavailableServers.length > 0) {
          console.warn("Unavailable MCP servers:", unavailableServers);
        }
      }

      if (message.type === "result" && message.subtype === "error_during_execution") {
        console.error("Execution failed");
      }
    }
} catch (error) {
// A single-shot query() throws after yielding an error result. If the
// failure was an error result, the error subtype branch above has
// already run; a failure to start or reach the Claude Code process
// yields no result message. MCP servers that fail to connect don't
// throw: use the status check above, and note that servers still
// "pending" at init need a later status check.
console.log(`Session ended with an error: ${error}`);
}
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage, ResultMessage


  async def main():
      # Replace data_server with your server configuration
      options = ClaudeAgentOptions(mcp_servers={"data-processor": data_server})

      try:
          async for message in query(prompt="Process data", options=options):
              if isinstance(message, SystemMessage) and message.subtype == "init":
                  unavailable_servers = [
                      s
                      for s in message.data.get("mcp_servers", [])
                      if s.get("status") in ("failed", "needs-auth")
                  ]

                  if unavailable_servers:
                      print(f"Unavailable MCP servers: {unavailable_servers}")

              if (
                  isinstance(message, ResultMessage)
                  and message.subtype == "error_during_execution"
              ):
                  print("Execution failed")
      except Exception as error:
          # A single-shot query() raises after yielding an error result. If the
          # failure was an error result, the error subtype branch above has
          # already run; a failure to start or reach the Claude Code process
          # yields no result message. MCP servers that fail to connect don't
          # raise: use the status check above, and note that servers still
          # "pending" at init need a later status check.
          print(f"Session ended with an error: {error}")


  asyncio.run(main())
  ```
</CodeGroup>

远程服务器的状态在报告 `"connected"` 后也可能会改变。当连接在会话中途断开时，Claude Code 会在 [重新连接](/docs/zh-CN/mcp#automatic-reconnection) 时将服务器移回 `"pending"`。之后在 TypeScript 中调用 `mcpServerStatus()`，或在 Python 中调用 [`ClaudeSDKClient.get_mcp_status()`](/docs/zh-CN/agent-sdk/python#methods)，可能会为您之前看到已连接的服务器报告 `"pending"`，而您这一方没有进行任何配置更改。

在五次重新连接尝试失败后，服务器报告 `"failed"`，或在需要再次授权时报告 `"needs-auth"`。要手动重试，请在 TypeScript 中调用 [`reconnectMcpServer()`](/docs/zh-CN/agent-sdk/typescript#methods) 或在 Python 中调用 [`ClaudeSDKClient.reconnect_mcp_server()`](/docs/zh-CN/agent-sdk/python#methods)。

<h2 id="troubleshooting">
  故障排除
</h2>

<h3 id="server-shows-failed-status">
  服务器显示"failed"状态
</h3>

检查 `init` 消息以查看哪些服务器连接失败：

<CodeGroup>
  ```typescript TypeScript theme={null}
  if (message.type === "system" && message.subtype === "init") {
    for (const server of message.mcp_servers) {
      if (server.status === "failed") {
        console.error(`Server ${server.name} failed to connect`);
      }
    }
  }
  ```

  ```python Python theme={null}
  if isinstance(message, SystemMessage) and message.subtype == "init":
      for server in message.data.get("mcp_servers", []):
          if server.get("status") == "failed":
              print(f"Server {server['name']} failed to connect")
  ```
</CodeGroup>

`"pending"` 状态并不意味着服务器连接失败。请参阅[错误处理](#error-handling)了解它在初始化时涵盖的情况。要在会话后期获取更新的状态，请在 TypeScript SDK 中调用查询的 `mcpServerStatus()` 方法，或在 Python 中调用 [`ClaudeSDKClient.get_mcp_status()`](/docs/zh-CN/agent-sdk/python#methods)。

常见原因：

* **缺少环境变量**：确保设置了所需的令牌和凭证。对于 stdio 服务器，检查 `env` 字段是否与服务器期望的相匹配。
* **服务器未安装**：对于 `npx` 命令，验证该包是否存在以及 Node.js 是否在您的 PATH 中。
* **无效的连接字符串**：对于数据库服务器，验证连接字符串格式以及数据库是否可访问。
* **网络问题**：对于远程 HTTP/SSE 服务器，检查 URL 是否可达以及任何防火墙是否允许连接。

<h3 id="tools-not-being-called">
  工具未被调用
</h3>

如果 Claude 看到工具但不使用它们，请检查您是否已使用 `allowedTools` 授予权限：

<CodeGroup>
  ```typescript TypeScript hidelines={1,-1} theme={null}
  const _ = {
    options: {
      mcpServers: {
        // your servers
      },
      allowedTools: ["mcp__servername__*"] // Auto-approve calls from this server
    }
  };
  ```

  ```python Python theme={null}
  options = ClaudeAgentOptions(
      mcp_servers={
          # your servers
      },
      allowed_tools=["mcp__servername__*"],  # Auto-approve calls from this server
  )
  ```
</CodeGroup>

<h3 id="connection-timeouts">
  连接超时
</h3>

MCP 服务器连接默认在 30 秒后超时。要更改运行中的工具调用可能需要的时间，请设置 [`MCP_TOOL_TIMEOUT`](/docs/zh-CN/env-vars)。如果您的服务器需要更长时间才能启动，连接将失败。使用 [`MCP_TIMEOUT`](/docs/zh-CN/env-vars) 环境变量（以毫秒为单位）提高连接限制。对于需要更多启动时间的服务器，还应考虑：

* 使用更轻量级的服务器（如果可用）
* 在启动代理之前预热服务器
* 检查服务器日志以查找缓慢初始化的原因

在 TypeScript 中，您可以通过将 [`timeout` 传递给 `createSdkMcpServer()`](/docs/zh-CN/agent-sdk/typescript#createsdkmcpserver) 来为单个 [SDK MCP 服务器](#sdk-mcp-servers) 设置工具调用限制。

<h3 id="tool-output-exceeds-maximum-allowed-tokens">
  工具输出超过最大允许令牌数
</h3>

SDK 应用与 Claude Code 相同的 MCP 输出限制。当没有图像内容的工具结果大于 25,000 个令牌时，Claude Code 会将输出保存到文件中，并用错误消息替换工具结果，该消息命名文件路径，以便代理可以分部分读取输出。

使用 [`MAX_MCP_OUTPUT_TOKENS`](/docs/zh-CN/env-vars) 环境变量提高限制。请参阅 [MCP 输出限制和警告](/docs/zh-CN/mcp#mcp-output-limits-and-warnings) 了解完整行为，包括服务器如何使用 `anthropic/maxResultSizeChars` 注释声明更高的每工具限制。

<h2 id="related-resources">
  相关资源
</h2>

* **[自定义工具指南](/docs/zh-CN/agent-sdk/custom-tools)**：构建您自己的 MCP 服务器，在 SDK 应用程序中进程内运行
* **[权限](/docs/zh-CN/agent-sdk/permissions)**：使用 `allowedTools` 和 `disallowedTools` 控制您的代理可以使用哪些 MCP 工具
* **[TypeScript SDK 参考](/docs/zh-CN/agent-sdk/typescript)**：完整的 API 参考，包括 MCP 配置选项
* **[Python SDK 参考](/docs/zh-CN/agent-sdk/python)**：完整的 API 参考，包括 MCP 配置选项
* **[MCP 服务器目录](https://github.com/modelcontextprotocol/servers)**：浏览可用的 MCP 服务器，用于数据库、API 等
