/** token 数量简写：<1K 原值；<1M 用 K；>=1M 用 M（保留 1 位小数）。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
