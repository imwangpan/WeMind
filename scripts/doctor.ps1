# WeMind 环境诊断（只读）
#
# 用途：给人和 AI 一份「当前机器上 WeMind 能不能跑、大脑是谁、agent 在哪」的事实，避免靠猜。不会修改任何文件，不会打印 token / API key 的内容。
#
# 用法：
#   pwsh -NoProfile -File scripts/doctor.ps1
#   pwsh -NoProfile -File scripts/doctor.ps1 -TailLogs
#
param(
  [string]$DataRoot = "",
  [switch]$TailLogs
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Section([string]$title) {
  Write-Output ""
  Write-Output "===== $title ====="
}
function Item([string]$name, [string]$value) {
  Write-Output ("{0,-28} {1}" -f $name, $value)
}
function YesNo([bool]$ok) { if ($ok) { "OK" } else { "--" } }

$repo = Split-Path -Parent $PSScriptRoot
if (-not $DataRoot) {
  $DataRoot = if ($env:WECHAT_DATA_DIR) { $env:WECHAT_DATA_DIR } else { Join-Path $env:USERPROFILE ".wemind" }
}

Section "WeMind doctor"
Item "时间" (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz")
Item "系统" ("{0} {1}" -f $env:OS, [System.Environment]::OSVersion.VersionString)
Item "PowerShell" $PSVersionTable.PSVersion.ToString()
Item "仓库" $repo
Item "数据根" $DataRoot

# ---------- Node / npm ----------
Section "Node / npm"
$nodeExe = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $nodeExe = $cmd.Source }
if (-not $nodeExe) {
  $cands = @(
    (Join-Path $env:APPDATA "fnm\aliases\default\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Volta\bin\node.exe"),
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
  )
  foreach ($c in $cands) {
    if ($c -and (Test-Path -LiteralPath $c)) { $nodeExe = $c; break }
  }
}
if ($nodeExe) {
  Item "node" $nodeExe
  Item "node --version" ((& $nodeExe --version 2>$null) -join " ")
  $npm = $null
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($npmCmd) { $npm = $npmCmd.Source }
  if (-not $npm) {
    $npmCand = Join-Path (Split-Path -Parent $nodeExe) "npm.cmd"
    if (Test-Path -LiteralPath $npmCand) { $npm = $npmCand }
  }
  if ($npm) { Item "npm" $npm; Item "npm --version" ((& $npm --version 2>$null) -join " ") }
  else { Item "npm" "未找到（PATH 上没有，也不在 node 同目录）" }
} else {
  Item "node" "未找到（PATH / fnm / Volta / Program Files 都没有）"
}
$fnm = Get-Command fnm -ErrorAction SilentlyContinue
if ($fnm) {
  Item "fnm" $fnm.Source
  Item "fnm list" ((& $fnm.Source list 2>&1) -join " ")
}

# ---------- 账号 ----------
Section "账号（$DataRoot）"
if (Test-Path -LiteralPath $DataRoot) {
  $accounts = Get-ChildItem -Directory -LiteralPath $DataRoot -ErrorAction SilentlyContinue
  if (-not $accounts) { Item "账号" "（无子目录）" }
  foreach ($a in $accounts) {
    $daemonPid = Join-Path $a.FullName "daemon.pid"
    $running = if (Test-Path -LiteralPath $daemonPid) { "pid=$(Get-Content -LiteralPath $daemonPid -ErrorAction SilentlyContinue)" } else { "未运行" }
    Item ("账号 " + $a.Name) $running
    $brainCfg = Join-Path $a.FullName "brain.json"
    if (Test-Path -LiteralPath $brainCfg) {
      try {
        $b = Get-Content -LiteralPath $brainCfg -Raw -ErrorAction Stop | ConvertFrom-Json
        $desc = "agent=$($b.agent)"
        if ($b.bin) { $desc += " bin=$($b.bin)" }
        if ($b.args) { $desc += " args=[$($b.args -join ' ')]" }
        if ($null -ne $b.shell) { $desc += " shell=$($b.shell)" }
        if ($b.homeEnvVar) { $desc += " home_env=$($b.homeEnvVar)" }
        Item "  brain.json" $desc
      } catch {
        Item "  brain.json" "存在但无法解析：$brainCfg"
      }
    } else {
      Item "  brain.json" "未设置（走 auto：kiro → opencode → gemini → deepseek → qoder → cline）"
    }
    $sess = Join-Path $a.FullName "brain-sessions.json"
    if (Test-Path -LiteralPath $sess) {
      try {
        $j = Get-Content -LiteralPath $sess -Raw | ConvertFrom-Json
        $n = @($j.PSObject.Properties).Count
        Item "  brain-sessions" "$n 个用户映射"
      } catch { Item "  brain-sessions" "存在但无法解析" }
    }
    $mcps = Join-Path $a.FullName "brain-mcps.json"
    if (Test-Path -LiteralPath $mcps) {
      try {
        $j = Get-Content -LiteralPath $mcps -Raw | ConvertFrom-Json
        Item "  激活 MCP" (($j.active -join ", ") + $(if (-not $j.active) { "（空）" } else { "" }))
      } catch { Item "  激活 MCP" "存在但无法解析" }
    }
    $brainHome = Join-Path $a.FullName "brain-home"
    Item "  brain-home" ("存在=" + (YesNo (Test-Path -LiteralPath $brainHome)))
    if ($TailLogs) {
      $log = Join-Path $a.FullName "daemon.log"
      if (Test-Path -LiteralPath $log) {
        Write-Output "  --- daemon.log 最后 5 行 ---"
        Get-Content -LiteralPath $log -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("  " + $_) }
      }
    }
  }
} else {
  Item "目录" "不存在（还没登录过）"
}

# ---------- Agent 二进制 ----------
Section "ACP agent 二进制"
$agents = @(
  @{ Name = "kiro-cli"; Preset = "kiro" },
  @{ Name = "opencode"; Preset = "opencode" },
  @{ Name = "dsh"; Preset = "deepseek（已内置预设）" },
  @{ Name = "dsh.cmd"; Preset = "deepseek（已内置预设）" },
  @{ Name = "deepseek-acp"; Preset = "社区 DeepSeek 适配器（评估中）" },
  @{ Name = "gemini"; Preset = "gemini（示例预设）" },
  @{ Name = "cline"; Preset = "cline（已内置预设）" },
  @{ Name = "codex-acp"; Preset = "codex（示例预设）" },
  @{ Name = "npx"; Preset = "适配器启动器（claude-code 等）" }
)
foreach ($a in $agents) {
  $c = Get-Command $a.Name -ErrorAction SilentlyContinue
  if ($c) { Item $a.Name ("{0}  [{1}]" -f $c.Source, $a.Preset) }
}
$dshDesktop = $null
$dshCandidates = @()
if ($env:LOCALAPPDATA) {
  $dshCandidates += (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
}
if ($env:ProgramFiles) {
  $dshCandidates += (Join-Path $env:ProgramFiles "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
}
if (${env:ProgramFiles(x86)}) {
  $dshCandidates += (Join-Path ${env:ProgramFiles(x86)} "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
}
# 安装器可能把 app 放到非系统盘的用户目录；遍历盘符找 <drive>:\Users\<user>\AppData\Local\Programs\...
foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
  if ($drive.Root) {
    $dshCandidates += (Join-Path $drive.Root "Users\$env:USERNAME\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd")
  }
}
foreach ($c in ($dshCandidates | Select-Object -Unique)) {
  if ($c -and (Test-Path -LiteralPath $c)) { $dshDesktop = $c; break }
}
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$hasDshPath = @(($userPath -split ";") | Where-Object { $_ -match "DeepSeek Harness" }).Count -gt 0
Item "用户 PATH 含 dsh 目录" (YesNo $hasDshPath)
if ($dshDesktop) {
  Item "dsh（桌面端）" $dshDesktop
  $ver = (& $dshDesktop --version 2>$null) -join " "
  if ($ver) {
    Item "  --version" $ver
    # 升级守卫：WeMind 的 deepseek 预设按此实测版本开发；版本变化时 ACP 面（resume/model/MCP）可能漂移
    if ($ver.Trim() -ne "0.2.1-rc.2") {
      Write-Output "  ⚠ dsh 版本与已实测版本（0.2.1-rc.2）不同：升级后先跑 node scripts/acp-probe.mjs 回归（initialize/resume/model/MCP），再让 daemon 使用。"
    }
  }
}
$dshHome = Join-Path $env:USERPROFILE ".dsh"
if (Test-Path -LiteralPath $dshHome) {
  Item "DSH_HOME" $dshHome
  Item "  .credentials.yaml" ("存在=" + (YesNo (Test-Path -LiteralPath (Join-Path $dshHome ".credentials.yaml"))))
  $sessCount = @(Get-ChildItem -Directory -LiteralPath (Join-Path $dshHome "sessions") -ErrorAction SilentlyContinue).Count
  Item "  sessions" "$sessCount 个"
}

# ---------- 环境变量 ----------
Section "环境变量（只显示是否设置，不显示值）"
$vars = @(
  "WEMIND_BRAIN", "WEMIND_BRAIN_BIN", "WEMIND_BRAIN_ARGS", "WEMIND_BRAIN_HOME_ENV",
  "WEMIND_BRAIN_SHELL", "WEMIND_BRAIN_INHERIT", "WEMIND_BRAIN_REAL_HOME",
  "WEMIND_BRAIN_INHERIT_DIRS", "WEMIND_MCP_CATALOG", "WECHAT_MCP_CATALOG",
  "WECHAT_DATA_DIR", "WEMIND_HOME", "WECHAT_ACCOUNT", "WECHAT_BRAIN_HOME",
  "WEMIND_WORKER_HOME", "WEMIND_WORKER_CWD", "WECHAT_CONSEC_SEND_LIMIT",
  "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"
)
foreach ($v in $vars) {
  $val = [Environment]::GetEnvironmentVariable($v)
  Item $v $(if ($null -ne $val -and $val -ne "") { "已设置（长度 $($val.Length)）" } else { "未设置" })
}

# ---------- 结论 ----------
Section "提示"
if (-not $nodeExe) { Write-Output '- 没有 node：daemon 起不来。装 Node 22+，或把 fnm/Volta 的 node 放进 PATH。' }
if (-not (Get-Command kiro-cli -ErrorAction SilentlyContinue) -and
    -not (Get-Command opencode -ErrorAction SilentlyContinue) -and
    -not $dshDesktop) {
  Write-Output '- PATH 上没发现 kiro/opencode/dsh：先装一个 ACP agent，或 wemind brain set <预设> --bin <绝对路径>。'
}
if ($dshDesktop) {
  Write-Output '- 桌面端 dsh 只有 dsh.cmd；接入预设时 binWin 要写 dsh.cmd（onPath 不会自动补 .cmd）。'
}
Write-Output '- 下一步：node packages/wechat-daemon/dist/cli.js list、... brain <key>、... brain check <key>。'
Write-Output '- 排查手册：docs/ai/recipes/debug-daemon.md；接入新 agent：docs/ai/recipes/add-acp-agent.md。'
