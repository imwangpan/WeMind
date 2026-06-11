# WeMind daemon 常驻包装脚本。
# 由 Windows 计划任务（登录触发）调用：定位仓库 -> 循环运行 daemon -> 崩溃后延迟重拉。
# 可移植：用 $PSScriptRoot 定位仓库根（本脚本位于 <repo>/scripts/），node/kiro-cli 走 PATH。
$ErrorActionPreference = "Continue"
# 以 UTF-8 解码子进程（node/kiro-cli）输出，否则中文按 GBK 代码页解码会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# 账号与数据目录（每账号独立）。日志写进各自数据目录，避免多账号共享 daemon.log 产生文件锁竞争
# （曾导致非默认账号的 wrapper 卡在写日志、起不来 daemon）。
$accountKey = if ($env:WECHAT_ACCOUNT) { $env:WECHAT_ACCOUNT } else { 'default' }
$dataDir = if ($env:WECHAT_DATA_DIR) { $env:WECHAT_DATA_DIR } else { Join-Path $env:USERPROFILE ".wemind\$accountKey" }
New-Item -ItemType Directory -Force -Path $dataDir -ErrorAction SilentlyContinue | Out-Null
$log = Join-Path $dataDir "daemon.log"

# 单实例守卫：同一账号只允许一个 wrapper 在跑，防止多次启动累积出多个自重启循环
# （表现为反复重生的 wrapper / 多 daemon 抢同一 token，即坑①）。
# 多账号用不同 WECHAT_ACCOUNT/WECHAT_DATA_DIR → 不同 mutex 名 → 各自独立、可共存。
$dataKey = if ($env:WECHAT_DATA_DIR) { $env:WECHAT_DATA_DIR } elseif ($env:WECHAT_ACCOUNT) { "account:$($env:WECHAT_ACCOUNT)" } else { "account:default" }
$sha = [System.Security.Cryptography.SHA1]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($dataKey.ToLower()))
$mutexName = "wemind-daemon-" + ([System.BitConverter]::ToString($sha) -replace '-','').Substring(0, 16)
$createdNew = $false
$global:WeMindMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  "[wrapper] 已有实例在跑（dataKey=$dataKey, mutex=$mutexName），本次退出。$(Get-Date -Format o)" | Add-Content $log
  exit 0
}

# 写 wrapper.pid 供管理命令（logout/delete）精确停止整条链
try { "$PID" | Set-Content -Path (Join-Path $dataDir 'wrapper.pid') -Encoding ascii } catch {}

# node 解析
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "node" }

# kiro-cli 兜底：PATH 找不到时用 LocalAppData 下的默认安装路径
if (-not (Get-Command kiro-cli -ErrorAction SilentlyContinue)) {
  $kc = Join-Path $env:LOCALAPPDATA "Kiro-Cli\kiro-cli.exe"
  if (Test-Path $kc) { $env:KIRO_CLI_BIN = $kc }
}

while ($true) {
  "[wrapper] start daemon $(Get-Date -Format o)" | Add-Content $log
  & $node "packages/wechat-daemon/dist/index.js" *>> $log
  "[wrapper] daemon exited (code=$LASTEXITCODE), restart in 5s $(Get-Date -Format o)" | Add-Content $log
  Start-Sleep -Seconds 5
}
