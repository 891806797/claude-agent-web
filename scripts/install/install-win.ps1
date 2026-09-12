# install-win.ps1 - 安装 csm-coding-agent-web 单 exe + 注册 deep-link 协议 + 投放 csmcode
# 用法: powershell -ExecutionPolicy Bypass -File install-win.ps1 -Exe bin\app-windows-x64-0.1.0.exe
#      powershell -ExecutionPolicy Bypass -File install-win.ps1 -Exe <exe> -Scheme csm-coding-agent-web
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Scheme = 'csm-coding-agent-web'
)
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'csm-coding-agent-web'
$Target = Join-Path $InstallDir 'app.exe'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $Exe $Target -Force

# 图标（来自 desktop resources；与安装器同目录的 assets\icon.ico）
$IconSrc = Join-Path $PSScriptRoot 'assets\icon.ico'
if (Test-Path $IconSrc) {
  Copy-Item $IconSrc (Join-Path $InstallDir 'icon.ico') -Force
}

# .env 模板（用户编辑实际值；首次安装才写，升级不覆盖）
$EnvFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $EnvFile)) {
  @"
DATABASE_URL=postgres://user:pass@host:5432/csm_agent_web
DB_SCHEMA=claude_agent_web
PORT=3000
DEEP_LINK_SCHEME=$Scheme
AGENT_WORKSPACE_ROOT=$InstallDir\workspaces
INTERFACE_PLATFORM_BASE_URL=https://openapi.msuncloud.com
UPDATE_MANIFEST_URL=
CSMCODE_USER=$env:USERNAME
"@ | Out-File $EnvFile -Encoding ascii
}

# 协议注册：HKCU\Software\Classes\<scheme>\shell\open\command = "exe" "%1"
$key = "HKCU:\Software\Classes\$Scheme"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'CSM Coding Agent Web Deep Link' -Type String
$cmdKey = "$key\shell\open\command"
New-Item -Path $cmdKey -Force | Out-Null
Set-ItemProperty -Path $cmdKey -Name '(default)' -Value "`"$Target`" `"%1`"" -Type String

# csmcode PATH shim（裸启 = --open 意图；--user 可覆盖审计用户名）
$ShimDir = Join-Path $InstallDir 'bin'
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
$Shim = Join-Path $ShimDir 'csmcode.cmd'
"@echo off`r`n`"$Target`" --open %*" | Out-File $Shim -Encoding ascii
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$ShimDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$ShimDir", 'User')
}

# Start Menu 快捷方式（bun --compile 不内嵌 exe 图标，用快捷方式 IconLocation 指向 icon.ico）
$ShortcutDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\CSM Coding Agent Web'
New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
$Lnk = Join-Path $ShortcutDir 'CSM Coding Agent Web.lnk'
$Shell = New-Object -ComObject WScript.Shell
$sc = $Shell.CreateShortcut($Lnk)
$sc.TargetPath = $Target
$sc.IconLocation = (Join-Path $InstallDir 'icon.ico')
$sc.Save()

Write-Host "Installed to $Target"
Write-Host "Protocol $Scheme:// -> $Target"
Write-Host "csmcode on PATH ($ShimDir); restart terminal to use"
Write-Host "Edit $EnvFile before first run (DATABASE_URL / UPDATE_MANIFEST_URL)"
