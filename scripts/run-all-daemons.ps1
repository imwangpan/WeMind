# WeMind 多账号自启脚本：读取 ~/.wemind/accounts.json，为每个已登记账号起一个 daemon wrapper。
# 各账号 mutex 独立 → 重复运行安全（已在跑的会被 run-daemon.ps1 的单实例守卫挡掉）。
$ErrorActionPreference = "Continue"
$root = Join-Path $env:USERPROFILE ".wemind"
$reg = Join-Path $root "accounts.json"
$wrapper = Join-Path $PSScriptRoot "run-daemon.ps1"
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
if (-not (Test-Path $pwsh)) { $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }

if (-not (Test-Path $reg)) { Write-Output "无账号注册表: $reg（先登录一个账号）"; exit 0 }
$accounts = (Get-Content $reg -Raw | ConvertFrom-Json).accounts
$keys = @($accounts.PSObject.Properties.Name)
if (-not $keys.Count) { Write-Output "注册表为空"; exit 0 }

foreach ($key in $keys) {
  Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$wrapper) -WindowStyle Hidden -Environment @{ WECHAT_ACCOUNT = $key }
  Write-Output "started wrapper for account: $key"
  Start-Sleep -Milliseconds 500
}
