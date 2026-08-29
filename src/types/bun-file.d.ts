/**
 * Bun file 导入声明 —— `import x from '...exe' with { type: 'file' }` 在编译版把
 * 文件以 asset 嵌入 bunfs 并返回其虚拟路径，dev 返回真实路径。类型仅为 string。
 * （@types/bun 未覆盖 *.exe 通配，项目内补声明。）
 */
declare module '*.exe' {
  const path: string
  export default path
}
