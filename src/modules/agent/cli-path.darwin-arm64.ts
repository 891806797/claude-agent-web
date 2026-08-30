// macOS（Apple Silicon）编译版专用：file 导入把 claude 嵌入 bunfs 并返回其虚拟路径。
// 独立模块的原因：file import 必须静态，而 SDK 平台包按 OS 安装（非 macOS 上本包不存在，
// 顶层静态导入会让服务启动即崩）——由 cli-path.ts 仅在 darwin-arm64 编译版下 require 本模块。
import binPath from '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' with { type: 'file' }

export default binPath
