/**
 * 自更新替换脚本模板 —— applyUpdate 写盘后 detached spawn，接手「等进程退出 → 替换 → 重启」。
 *
 * 为什么用外部脚本而非自 spawn exe：Windows 运行中 exe 文件被锁，无法自我覆盖；
 * 必须由独立解释器（powershell / sh）在原进程退出后替换。两解释器各平台默认存在。
 * 脚本文本内嵌（编译进单 exe），运行时落盘到 temp 再执行。
 */

/** Windows：PowerShell。pid 退出后 Move-Item 覆盖，重启 exe。 */
export function winUpdaterScript(): string {
  return `# csm-coding-agent-web updater
param($Pid_, $New, $Target)
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-Process -Id $Pid_ -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}
try { Move-Item -Force $New $Target } catch { exit 2 }
Start-Process -FilePath $Target
`
}

/** POSIX：sh。pid 退出后 mv 覆盖 + chmod + 后台重启。 */
export function posixUpdaterScript(): string {
  return `#!/bin/sh
# csm-coding-agent-web updater
Pid_=$1
New=$2
Target=$3
i=0
while [ $i -lt 60 ]; do
  kill -0 "$Pid_" 2>/dev/null || break
  sleep 1
  i=$((i+1))
done
mv -f "$New" "$Target" || exit 2
chmod +x "$Target" || exit 3
"$Target" &
`
}
