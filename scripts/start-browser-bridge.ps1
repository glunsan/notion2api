param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $project 'src\index.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Notion2API source entry is missing.' }
$env:NOTION_TRANSPORT = 'browser'
if ($Foreground) {
    Push-Location -LiteralPath $project
    try { & $node '--env-file-if-exists=.env' $entry } finally { Pop-Location }
    exit $LASTEXITCODE
}
$local = Join-Path $project '.local'
New-Item -ItemType Directory -Force -Path $local | Out-Null
$pidFile = Join-Path $local 'browser-bridge.pid'
if (Test-Path -LiteralPath $pidFile) {
    $oldId = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$oldId) -and (Get-Process -Id $oldId -ErrorAction SilentlyContinue)) {
        throw 'A previously launched bridge process still exists. Inspect it before starting another.'
    }
}
$process = Start-Process -FilePath $node -ArgumentList @('--env-file-if-exists=.env', ('"' + $entry + '"')) `
    -WorkingDirectory $project -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $local 'browser-bridge.stdout.log') `
    -RedirectStandardError (Join-Path $local 'browser-bridge.stderr.log')
$process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
[pscustomobject]@{ StartedPid = $process.Id; ApiBase = 'http://127.0.0.1:8787/v1'; BrowserConnectionRequired = $true; PidFile = $pidFile } | ConvertTo-Json
