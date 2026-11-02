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

foreach ($key in $keys) {
  $childEnv = @{ WECHAT_ACCOUNT = $key }
  if ($env:WEMIND_HOME) { $childEnv['WEMIND_HOME'] = $env:WEMIND_HOME }
  if ($env:WECHAT_DATA_DIR) { $childEnv['WECHAT_DATA_DIR'] = $null } # 多账号不能共用单账号目录
  Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$wrapper) -WindowStyle Hidden -Environment $childEnv
  Write-Output "started wrapper for account: $key"
  Start-Sleep -Milliseconds 500
}
