# mcp-wechat-server daemon 常驻包装脚本。
# 由 Windows 计划任务（登录触发）调用：定位仓库 -> 循环运行 daemon -> 崩溃后延迟重拉。
# 可移植：用 $PSScriptRoot 定位仓库根（本脚本位于 <repo>/scripts/），node/kiro-cli 走 PATH。
$ErrorActionPreference = "Continue"
# 以 UTF-8 解码子进程（node/kiro-cli）输出，否则中文按 GBK 代码页解码会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo "daemon.log"

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
  & $node "dist/daemon/index.js" *>> $log
  "[wrapper] daemon exited (code=$LASTEXITCODE), restart in 5s $(Get-Date -Format o)" | Add-Content $log
  Start-Sleep -Seconds 5
}
