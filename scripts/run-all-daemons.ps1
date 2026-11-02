# WeMind 多账号自启脚本：读取 <WEMIND_HOME>/accounts.json，为每个已登记账号起一个 daemon wrapper。
# 根目录与 core 一致：WEMIND_HOME > ~/.wemind。WECHAT_DATA_DIR 是「单账号覆盖」，不能用于多账号——这里会提示并从子进程环境中移除，避免所有账号共用同一目录。
# 各账号 mutex 独立 → 重复运行安全（已在跑的会被 run-daemon.ps1 的单实例守卫挡掉）。
$ErrorActionPreference = "Continue"
$root = if ($env:WEMIND_HOME) { $env:WEMIND_HOME } else { Join-Path $env:USERPROFILE ".wemind" }
$reg = Join-Path $root "accounts.json"
$wrapper = Join-Path $PSScriptRoot "run-daemon.ps1"
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
if (-not (Test-Path $pwsh)) { $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }

if ($env:WECHAT_DATA_DIR) {
  Write-Warning "检测到 WECHAT_DATA_DIR（单账号覆盖）；多账号自启会把它从子进程环境中移除。要整体迁移根目录请改用 WEMIND_HOME。"
}

if (-not (Test-Path $reg)) { Write-Output "无账号注册表: $reg（先登录一个账号）"; exit 0 }
$accounts = (Get-Content $reg -Raw | ConvertFrom-Json).accounts
$keys = @($accounts.PSObject.Properties.Name)
if (-not $keys.Count) { Write-Output "注册表为空"; exit 0 }

# 多账号的全局 worker 预算：设置 WEMIND_MAX_WORKERS_TOTAL 后按账号数均分给每个 daemon（至少 1）。
# 只在本脚本拉起的 daemon 上生效；单独 wemind start 的 daemon 仍按自己的 WEMIND_MAX_WORKERS 计。
$totalWorkers = 0
if ($env:WEMIND_MAX_WORKERS_TOTAL) {
  if (-not [int]::TryParse($env:WEMIND_MAX_WORKERS_TOTAL, [ref]$totalWorkers) -or $totalWorkers -lt 1) {
    Write-Warning "WEMIND_MAX_WORKERS_TOTAL 不是正整数，已忽略：$($env:WEMIND_MAX_WORKERS_TOTAL)"
    $totalWorkers = 0
  }
}
$perAccountWorkers = 0
if ($totalWorkers -gt 0) {
  $perAccountWorkers = [Math]::Max(1, [Math]::Floor($totalWorkers / $keys.Count))
  Write-Output "worker 并发全局预算 $totalWorkers → 每账号 $perAccountWorkers（共 $($keys.Count) 个账号；已在运行的 daemon 需重启才生效）"
}

foreach ($key in $keys) {
  $childEnv = @{ WECHAT_ACCOUNT = $key }
  if ($env:WEMIND_HOME) { $childEnv['WEMIND_HOME'] = $env:WEMIND_HOME }
  if ($env:WECHAT_DATA_DIR) { $childEnv['WECHAT_DATA_DIR'] = $null } # 多账号不能共用单账号目录
  if ($perAccountWorkers -gt 0) { $childEnv['WEMIND_MAX_WORKERS'] = "$perAccountWorkers" }
  Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$wrapper) -WindowStyle Hidden -Environment $childEnv
  Write-Output "started wrapper for account: $key"
  Start-Sleep -Milliseconds 500
}
