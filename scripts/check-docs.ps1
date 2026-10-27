# WeMind docs link check (read-only)
#
# 扫描仓库内 Markdown 的相对链接，报告断链。CI 或提交前可跑：
#   pwsh -NoProfile -File scripts/check-docs.ps1
#
# 跳过：http(s)/mailto/#锚点、node_modules、dist、.git，以及 agent 的 worktree 副本（`.claude/worktrees/`、`.agents/`）——那里的 Markdown 是同一批文件的另一份检出，扫进去会让「检查数」翻倍（实测 39→78 文件、244→488 链接），与 vitest 排除 .agents 是同一类问题；CI 没有这些目录，只在本地跑时出现。
param(
  [string]$Root = ""
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path

$files = Get-ChildItem -LiteralPath $Root -Recurse -Filter *.md -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notmatch '[\\/](node_modules|dist|\.git)[\\/]' -and
    $_.FullName -notmatch '[\\/](\.claude[\\/]worktrees|\.agents)[\\/]'
  }

$broken = @()
$checked = 0
$linkRe = [regex]'\[[^\]]*\]\(([^)]+)\)'

foreach ($f in $files) {
  $lineNo = 0
  $inFence = $false
  foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
    $lineNo++
    if ($line -match '^\s*(```|~~~)') { $inFence = -not $inFence; continue }
    if ($inFence) { continue }
    # 去掉行内代码，避免把 `![](示例)` 之类当成真链接
    $clean = [regex]::Replace($line, '`[^`]*`', '')
    foreach ($m in $linkRe.Matches($clean)) {
      $target = $m.Groups[1].Value.Trim()
      if ($target -match '^(https?:|mailto:|#)') { continue }
      $target = $target -replace '^<|>$', ''
      $target = $target -replace '\s+"[^"]*"$', ''   # 去掉 Markdown title
      $target = $target.Split('#')[0]
      if (-not $target) { continue }
      $checked++
      $resolved = Join-Path $f.DirectoryName $target
      if (-not (Test-Path -LiteralPath $resolved)) {
        $broken += [pscustomobject]@{
          File = $f.FullName.Substring($Root.Length).TrimStart('\')
          Line = $lineNo
          Target = $target
        }
      }
    }
  }
}

Write-Output ("checked {0} relative links in {1} markdown files" -f $checked, $files.Count)
if ($broken.Count -eq 0) {
  Write-Output "OK: no broken relative links"
  exit 0
}
Write-Output ("BROKEN: {0}" -f $broken.Count)
$broken | Sort-Object File, Line | Format-Table -AutoSize
exit 1
