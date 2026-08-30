/**
 * Bun file 导入声明 —— `import x from '...claude' with { type: 'file' }` 在编译版把
 * 文件以 asset 嵌入 bunfs 并返回其虚拟路径，dev 返回真实路径。类型仅为 string。
 * （@types/bun 未覆盖这些平台二进制说明符，项目内补声明。）
 */
declare module '*.exe' {
  const path: string
  export default path
}

declare module '@anthropic-ai/claude-agent-sdk-linux-x64/claude' {
  const path: string
  export default path
}

declare module '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude' {
  const path: string
  export default path
}
