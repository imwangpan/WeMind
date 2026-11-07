# WeMind daemon 启动/常驻外壳（源码仓库专用）。
#
# 两种模式（-Mode）：
#   cli   （默认）薄壳：定位 node 与仓库根，交给 `wemind start` / `start --all`，由内置 `_watchdog` 负责崩溃重拉。
#         源码开发者与发布版走同一条常驻代码路径，只保留一份 watchdog 实现。
#   shell 旧行为：PowerShell 自己的监督循环（命名 Mutex 单实例 + 每 5s 重拉 + 每次重拉前轮转日志），直接跑 `cli.js daemon`。
#
# 由 Windows 计划任务（登录触发）调用。可移植：用 $PSScriptRoot 定位仓库根（本脚本位于 <repo>/scripts/）。
#
# 用法：
#   pwsh -File scripts/run-daemon.ps1                     # 默认账号，cli 模式
#   pwsh -File scripts/run-daemon.ps1 -Account <key>      # 指定账号
#   pwsh -File scripts/run-daemon.ps1 -All                # 所有已登记账号（等价 wemind start --all）
#   pwsh -File scripts/run-daemon.ps1 -Mode shell         # 旧 PowerShell 监督循环
#   pwsh -File scripts/run-daemon.ps1 -DryRun             # 只打印将执行的命令（自检/测试）
#
# 注意：这条外壳（以及任何系统触发器）绝不能执行 `wemind autostart install`——每次登录都会重新安装一遍。
param(
  [ValidateSet("cli", "shell")]
  [string]$Mode = "cli",
  [string]$Account = "",
  [switch]$All,
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"
# 以 UTF-8 解码子进程（node/kiro-cli）输出，否则中文按 GBK 代码页解码会乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$cli = Join-Path $repo "packages\wechat-daemon\dist\cli.js"

if ($All -and $Account) {
  [Console]::Error.WriteLine("-All 与 -Account 不能同时使用。")
  exit 2
}

# node 解析：优先 PATH；PATH 里没有时回退到已知「版本管理器稳定目录」。
# fnm / nvm / Volta 等只往**交互 shell** 注入 PATH，计划任务/服务（-NoProfile、无 shell 注入）的持久 PATH 里常常没有 node。这里不仅找到 node，还把它所在目录**前置进 PATH**——因为 daemon 拉起的大脑子进程（opencode / kiro-cli 等）同样靠 PATH 解析。
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$nodeFallbackNote = $null
if (-not $node) {
  $nodeCandidates = @(
    (Join-Path $env:APPDATA 'fnm\aliases\default\node.exe'),   # fnm：跟随 `fnm default`
    (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),        # Volta
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),           # 官方安装 / nvm-windows symlink
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )
  foreach ($cand in $nodeCandidates) {
    if ($cand -and (Test-Path $cand)) {
      $node = $cand
      $env:PATH = "$(Split-Path -Parent $cand);$env:PATH"
      $nodeFallbackNote = "PATH 中无 node，回退到 $cand 并前置其目录到 PATH"
      break
    }
  }
}
if (-not $node) { $node = "node" }

# kiro-cli 兜底：PATH 找不到时用 LocalAppData 下的默认安装路径
if (-not (Get-Command kiro-cli -ErrorAction SilentlyContinue)) {
  $kc = Join-Path $env:LOCALAPPDATA "Kiro-Cli\kiro-cli.exe"
  if (Test-Path $kc) { $env:KIRO_CLI_BIN = $kc }
}

# 账号：-Account 优先，其次 WECHAT_ACCOUNT；都没有时交给 CLI 选默认账号（shell 模式则沿用旧的 "default"）。
$explicitKey = if ($Account) { $Account } elseif ($env:WECHAT_ACCOUNT) { $env:WECHAT_ACCOUNT } else { "" }

# ---------------------------------------------------------------------------
# cli 模式（默认）：薄壳，常驻交给内置 _watchdog
# ---------------------------------------------------------------------------
if ($Mode -eq "cli") {
  $cliArgs = @($cli, "start")
  if ($All) {
    $cliArgs += "--all"
  } elseif ($explicitKey) {
    $cliArgs += $explicitKey
  }

  if ($nodeFallbackNote) { [Console]::Error.WriteLine("[wemind] $nodeFallbackNote") }
  if ($DryRun) {
    Write-Output ("DRYRUN mode=cli node=" + $node + " args=" + ($cliArgs -join " "))
    exit 0
  }
  if (-not (Test-Path -LiteralPath $cli)) {
    [Console]::Error.WriteLine("找不到 $cli。先在仓库根运行 npm run build。")
    exit 1
  }
  & $node @cliArgs
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------------------
# shell 模式：旧的 PowerShell 监督循环（直接跑 `cli.js daemon`）
# ---------------------------------------------------------------------------
$accountKey = if ($explicitKey) { $explicitKey } else { 'default' }
if ($Account) { $env:WECHAT_ACCOUNT = $Account }

if ($DryRun) {
  Write-Output ("DRYRUN mode=shell node=" + $node + " args=" + $cli + " daemon account=" + $accountKey)
  exit 0
}
if (-not (Test-Path -LiteralPath $cli)) {
  [Console]::Error.WriteLine("找不到 $cli。先在仓库根运行 npm run build。")
  exit 1
}

# 账号与数据目录（每账号独立）。日志写进各自数据目录，避免多账号共享 daemon.log 产生文件锁竞争（曾导致非默认账号的 wrapper 卡在写日志、起不来 daemon）。
# 根目录解析顺序与 core 的 WEMIND_ROOT 一致：WEMIND_HOME > ~/.wemind；WECHAT_DATA_DIR 仍可单独覆盖「本账号」的数据目录（shell 模式直接跑 daemon，保留该变量的单进程覆盖语义）。
$root = if ($env:WEMIND_HOME) { $env:WEMIND_HOME } else { Join-Path $env:USERPROFILE ".wemind" }
$dataDir = if ($env:WECHAT_DATA_DIR) { $env:WECHAT_DATA_DIR } else { Join-Path $root $accountKey }
New-Item -ItemType Directory -Force -Path $dataDir -ErrorAction SilentlyContinue | Out-Null
$log = Join-Path $dataDir "daemon.log"

# daemon.log 轮转（与内置 watchdog 的 log-rotate.ts 同一口径：daemon.log → .1 最新 … .<keep> 最旧）。
# 内置 watchdog 在运行中逐块轮转；本脚本的 `*>> $log` 在子进程存活期间持有文件，只能在每次重拉前（已退出）轮转。
$logMaxMb = 0.0
if ($env:WEMIND_LOG_MAX_MB -and [double]::TryParse($env:WEMIND_LOG_MAX_MB, [ref]$logMaxMb) -and $logMaxMb -gt 0) {
  $logMaxBytes = [long]($logMaxMb * 1MB)
} else {
  $logMaxBytes = 10MB
}
$logKeep = 3
if ($env:WEMIND_LOG_KEEP) {
  $parsedKeep = 0
  if ([int]::TryParse($env:WEMIND_LOG_KEEP, [ref]$parsedKeep) -and $parsedKeep -ge 0) { $logKeep = $parsedKeep }
}
function Rotate-DaemonLog {
  if (-not (Test-Path -LiteralPath $log)) { return }
  if ((Get-Item -LiteralPath $log).Length -lt $logMaxBytes) { return }
  if ($logKeep -le 0) {
    Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
    return
  }
  Remove-Item -LiteralPath "$log.$logKeep" -Force -ErrorAction SilentlyContinue
  for ($i = $logKeep - 1; $i -ge 1; $i--) {
    $src = "$log.$i"
    if (Test-Path -LiteralPath $src) {
      Move-Item -LiteralPath $src -Destination "$log.$($i + 1)" -Force -ErrorAction SilentlyContinue
    }
  }
  Move-Item -LiteralPath $log -Destination "$log.1" -Force -ErrorAction SilentlyContinue
}

# 单实例守卫：同一账号只允许一个 wrapper 在跑，防止多次启动累积出多个自重启循环（表现为反复重生的 wrapper / 多 daemon 抢同一 token，即坑①）。
# 多账号用不同 WECHAT_ACCOUNT/WECHAT_DATA_DIR → 不同 mutex 名 → 各自独立、可共存。
# 自定义 WEMIND_HOME 时必须把根目录算进 mutex：否则两个不同根目录下的同名账号会互相挡。
$dataKey = if ($env:WECHAT_DATA_DIR) { $env:WECHAT_DATA_DIR } elseif ($env:WEMIND_HOME) { "home:$($env:WEMIND_HOME)|account:$accountKey" } elseif ($env:WECHAT_ACCOUNT) { "account:$($env:WECHAT_ACCOUNT)" } else { "account:default" }
$sha = [System.Security.Cryptography.SHA1]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($dataKey.ToLower()))
$mutexName = "wemind-daemon-" + ([System.BitConverter]::ToString($sha) -replace '-','').Substring(0, 16)
$createdNew = $false
$global:WeMindMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  if ($nodeFallbackNote) { "[wemind/wechat-daemon/wrapper] $nodeFallbackNote" | Add-Content $log }
  "[wemind/wechat-daemon/wrapper] 已有实例在跑（dataKey=$dataKey, mutex=$mutexName），本次退出。$(Get-Date -Format o)" | Add-Content $log
  exit 0
}

# 写 wrapper.pid 供管理命令（logout/delete）精确停止整条链
try { "$PID" | Set-Content -Path (Join-Path $dataDir 'wrapper.pid') -Encoding ascii } catch {}

if ($nodeFallbackNote) { "[wemind/wechat-daemon/wrapper] $nodeFallbackNote" | Add-Content $log }

$maxRestarts = if ($env:WEMIND_MAX_RESTARTS -and [int]$env:WEMIND_MAX_RESTARTS -gt 0) { [int]$env:WEMIND_MAX_RESTARTS } else { 50 }
$crashes = 0

while ($true) {
  $startedAt = Get-Date
  Rotate-DaemonLog
  "[wemind/wechat-daemon/wrapper] start daemon $(Get-Date -Format o)" | Add-Content $log
  & $node $cli daemon *>> $log
  $code = $LASTEXITCODE
  # 退出码 78 = 大脑配置错误（见 brain-agents.ts 的 BRAIN_CONFIG_EXIT_CODE）：
  # 需人工修（换预设 / 装二进制），重拉无益 → 停在循环外，避免每 5s 刷一条日志。
  if ($code -eq 78) {
    "[wemind/wechat-daemon/wrapper] 大脑配置错误（exit 78），已停止自动重启。修好后重新登录或手动启动。$(Get-Date -Format o)" | Add-Content $log
    break
  }
  # 退出码 75 = 同账号已有另一个 daemon 在跑（见 watchdog-runner.ts 的 DAEMON_ALREADY_RUNNING_EXIT_CODE）：
  # 另一个实例已经在消费同一个 bot token，重拉只会每 5s 撞一次 → 停在循环外。
  if ($code -eq 75) {
    "[wemind/wechat-daemon/wrapper] 同账号已有 daemon 在跑（exit 75），已停止自动重启。$(Get-Date -Format o)" | Add-Content $log
    break
  }
  # 连续崩溃上限（与 pm2 / builtin watchdog 对齐）：跑满 10 分钟视为稳定、计数清零，
  # 短暂活一下就崩才连续计数；超过上限停在循环外，避免崩溃循环无限刷日志。
  if (((Get-Date) - $startedAt).TotalMilliseconds -ge 600000) { $crashes = 0 }
  $crashes += 1
  if ($crashes -gt $maxRestarts) {
    "[wemind/wechat-daemon/wrapper] 连续崩溃 $crashes 次（上限 $maxRestarts），已停止自动重启。看 daemon.log 排查；修好后重新启动。$(Get-Date -Format o)" | Add-Content $log
    break
  }
  "[wemind/wechat-daemon/wrapper] daemon exited (code=$code), restart in 5s $(Get-Date -Format o)" | Add-Content $log
  Start-Sleep -Seconds 5
}
