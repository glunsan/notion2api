#requires -Version 7.0
<#
.SYNOPSIS
Validate a localhost Notion2API generation; optionally register a non-default OpenCodex provider.
.EXAMPLE
pwsh -File .\scripts\connect-opencodex.ps1 -Model '<actual upstream model ID>'
.EXAMPLE
pwsh -File .\scripts\connect-opencodex.ps1 -Model '<actual upstream model ID>' -Register
.NOTES
Verified against installed OpenCodex 2.81.0. Default mode only validates the bridge.
The only credential source is ../.local/api-key.txt. No Notion login files are read.
Registration needs the current user's running, standalone/local OpenCodex management API.
No start/restart, set-default, force, sync, client installation or global environment writes.
Existing notion2api registrations always stop, even if their public fields look identical.
Rollback, after reviewing ownership and confirming notion2api is not the default:
  ocx provider remove notion2api --live --yes --json
That removes the provider and its associated key/model state; it does not delete this bridge.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Model,
    [string]$BaseUrl = 'http://127.0.0.1:8787/v1',
    [string]$OcxPath = 'E:\az\npm-global\ocx.ps1',
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 180,
    [switch]$Register
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BridgeBaseUrl([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'http' -or
        $uri.DnsSafeHost -notin @('localhost', '127.0.0.1', '::1') -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $uri.AbsolutePath.TrimEnd('/') -cne '/v1') {
        throw 'BaseUrl must be a plain HTTP localhost/127.0.0.1/[::1] URL ending in /v1.'
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

function Read-BridgeApiKey([string]$BridgeRoot) {
    $directory = Get-Item -LiteralPath (Join-Path $BridgeRoot '.local')
    $file = Get-Item -LiteralPath (Join-Path $directory.FullName 'api-key.txt')
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $file.PSIsContainer -or $file.Length -gt 4096) {
        throw 'The local bridge API-key source is not a regular bounded file.'
    }
    $key = [IO.File]::ReadAllText($file.FullName).Trim()
    if (-not $key -or $key -match '[\s\p{Cc}]' -or [Text.Encoding]::UTF8.GetByteCount($key) -gt 4096) {
        throw 'The local bridge API key must be one nonempty line without whitespace.'
    }
    return $key
}

function Invoke-BridgeJson([string]$Url, [string]$ApiKey, [hashtable]$Body, [int]$Timeout) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $Url)
    $response = $null
    try {
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $ApiKey)
        $request.Content = [Net.Http.StringContent]::new(
            ($Body | ConvertTo-Json -Depth 10 -Compress), [Text.Encoding]::UTF8, 'application/json')
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) {
            throw 'Bridge did not return HTTP 200.'
        }
        $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 1048576) { throw 'Bridge response too large.' }
        return ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 40
    } catch {
        # Never include request headers, credential-bearing exceptions or upstream error bodies.
        throw 'Local Notion2API generation failed (HTTP, timeout or invalid JSON); no provider registration is allowed.'
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
    }
}

function Test-BridgeGeneration([string]$Url, [string]$ApiKey, [string]$ModelId, [int]$Timeout) {
    $challenge = 'NOTION2API_OK_' + [Guid]::NewGuid().ToString('N')
    $body = @{
        model = $ModelId
        stream = $false
        messages = @(@{ role = 'user'; content = "Reply with exactly this token and nothing else: $challenge" })
    }
    $reply = Invoke-BridgeJson ($Url + '/chat/completions') $ApiKey $body $Timeout
    if ($reply -isnot [System.Collections.IDictionary] -or $reply.Contains('error') -or
        -not $reply.Contains('choices') -or $reply.choices -isnot [System.Collections.IList] -or
        $reply.choices.Count -lt 1) { throw 'Bridge response has no real completion; registration refused.' }
    $choice = $reply.choices[0]
    if ($choice -isnot [System.Collections.IDictionary] -or -not $choice.Contains('message') -or
        $choice.message -isnot [System.Collections.IDictionary] -or -not $choice.message.Contains('content') -or
        -not $choice.message.Contains('role') -or $choice.message.role -cne 'assistant' -or
        $choice.message.content -isnot [string] -or $choice.message.content.Trim() -cne $challenge -or
        -not $choice.Contains('finish_reason') -or $choice.finish_reason -cne 'stop') {
        throw 'Bridge did not complete the fresh generation challenge; registration refused.'
    }
    Write-Host 'Local Notion2API generation challenge passed.'
}

function Initialize-OcxCli([string]$ShimPath) {
    $shim = Get-Item -LiteralPath $ShimPath
    $installRoot = $shim.Directory.FullName
    $script:OcxLauncher = Join-Path $installRoot 'node_modules\@bitkyc08\opencodex\bin\ocx.mjs'
    if (-not (Test-Path -LiteralPath $script:OcxLauncher -PathType Leaf)) {
        throw 'The installed OpenCodex Node launcher was not found beside the supplied shim.'
    }
    $script:OcxNode = Join-Path $installRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $script:OcxNode -PathType Leaf)) {
        $script:OcxNode = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    }
    $version = Invoke-OcxCli @('--version') -TextOnly
    if ($version.Trim() -cne 'opencodex 2.81.0') {
        throw 'This script was verified for OpenCodex 2.81.0; review the installed CLI contract before registration.'
    }
    $accountHelp = Invoke-OcxCli @('help', 'account', 'add-key') -TextOnly
    $script:OcxInstallRoot = Join-Path $installRoot 'node_modules\@bitkyc08\opencodex'
    $script:OcxBun = Join-Path $script:OcxInstallRoot 'node_modules\bun\bin\bun.exe'
    if ($accountHelp -notmatch 'non-TTY stdin' -or -not (Test-Path -LiteralPath $script:OcxBun -PathType Leaf)) {
        throw 'The installed CLI/runtime does not match the verified stdin and management contracts.'
    }
}

function Invoke-OcxCli([string[]]$Arguments, [string]$InputText, [switch]$TextOnly) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:OcxNode
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $start.ArgumentList.Add($script:OcxLauncher)
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $diagnostic = 'unknown_cli_failure'
    $stage = if ($Arguments.Count -ge 2 -and $Arguments[0] -in @('provider', 'account')) {
        $Arguments[0] + ' ' + $Arguments[1]
    } else { 'preflight' }
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($PSBoundParameters.ContainsKey('InputText')) { $process.StandardInput.WriteLine($InputText) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(120000)) {
            $process.Kill($true)
            throw 'CLI timeout; write outcome may be unknown.'
        }
        $raw = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            $knownErrors = [ordered]@{
                'Provider batch input must be an editable provider snapshot' = 'invalid_editor_snapshot'
                'Provider baseline is stale.' = 'stale_provider_editor_baseline'
                'The target refused the provider configuration.' = 'invalid_provider'
                'The proposed provider configuration is invalid.' = 'invalid_provider_editor_config'
                'The target refused a provider destination.' = 'invalid_provider_destination'
                'Unable to read JSON input' = 'json_input_read_failed'
                'JSON input must contain valid JSON' = 'invalid_json_input'
                'Provider apply requires --baseline FILE' = 'invalid_apply_arguments'
                'Provider operation did not return a usable outcome.' = 'invalid_cli_receipt'
                'The provider request failed.' = 'management_request_failed'
            }
            foreach ($known in $knownErrors.Keys) {
                if ($errorText.Contains($known)) { $diagnostic = $knownErrors[$known]; break }
            }
            throw 'CLI returned a nonzero exit; write outcome may be partial.'
        }
        if ($TextOnly) { return $raw }
        return ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 100
    } catch {
        throw "OpenCodex CLI operation failed at $stage ($diagnostic). Inspect the current target before retrying; no rollback is implied. Raw output is withheld."
    } finally { $process.Dispose() }
}

function ConvertTo-StableValue($Value) {
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($name in ($Value.Keys | Sort-Object -CaseSensitive)) {
            $ordered[$name] = ConvertTo-StableValue $Value[$name]
        }
        return $ordered
    }
    if ($Value -is [System.Collections.IList]) {
        return ,@($Value | ForEach-Object { ConvertTo-StableValue $_ })
    }
    return $Value
}

function Assert-OwnedRow($Snapshot, $ExpectedRow, [string]$DefaultProvider) {
    if ($Snapshot.defaultProvider -cne $DefaultProvider -or -not $Snapshot.providers.Contains('notion2api')) {
        throw 'The default or provider registration changed; no further writes are allowed.'
    }
    $actual = ConvertTo-StableValue $Snapshot.providers['notion2api'] | ConvertTo-Json -Depth 100 -Compress
    $expected = ConvertTo-StableValue $ExpectedRow | ConvertTo-Json -Depth 100 -Compress
    if ($actual -cne $expected) {
        throw 'The notion2api public configuration does not exactly match this registration; no further writes are allowed.'
    }
}

function Invoke-SingleProviderChange($Baseline, $Row, [string]$Operation, [string]$BridgeRoot) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:OcxBun
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $start.ArgumentList.Add((Join-Path $BridgeRoot 'scripts\ocx-single-provider.mjs'))
    $start.ArgumentList.Add($script:OcxInstallRoot)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine((@{ operation=$Operation; baseline=$Baseline; row=$Row } | ConvertTo-Json -Depth 100 -Compress))
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(120000)) { $process.Kill($true); throw 'Scoped registration timed out; inspect current state.' }
        $raw = $stdout.GetAwaiter().GetResult()
        $diagnosticRaw = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            $safeStage = 'unknown'; $safeCode = 'unknown'
            try {
                $diagnostic = $diagnosticRaw | ConvertFrom-Json -AsHashtable
                if ($diagnostic.stage -in @('preflight','locate','read','create','enable','readback')) { $safeStage = $diagnostic.stage }
                if ($diagnostic.code -in @('unsupported_install','input_too_large','invalid_input','invalid_row','nonlocal_management','invalid_snapshot','stale_baseline','provider_exists','ownership_changed','invalid_receipt','readback_changed','management_operation_failed')) { $safeCode = $diagnostic.code }
            } catch {}
            throw "Scoped provider operation failed at $safeStage ($safeCode); inspect current state before retrying. Raw output withheld."
        }
        $receipt = $raw | ConvertFrom-Json -AsHashtable
        if ($receipt.success -ne $true) { throw 'Scoped registration receipt invalid.' }
    } finally { $process.Dispose() }
}

function Connect-Notion2Api([string]$BridgeRoot, [string]$Url, [string]$ModelId, [string]$ShimPath, [int]$Timeout, [bool]$DoRegister) {
    $url = Get-BridgeBaseUrl $Url
    if ($ModelId.Length -gt 256 -or $ModelId -match '[\s\p{Cc}]') { throw 'Use an actual upstream model ID without whitespace.' }
    $baseline = $null
    if ($DoRegister) {
        Initialize-OcxCli $ShimPath
        $baseline = Invoke-OcxCli @('provider', 'snapshot', '--json')
        if ($baseline.providers.Contains('notion2api')) {
            throw 'Provider notion2api already exists. It will never be overwritten or given a new key by this script.'
        }
    }
    $key = $null
    try {
        $key = Read-BridgeApiKey $BridgeRoot
        Test-BridgeGeneration $url $key $ModelId $Timeout
        if (-not $DoRegister) {
            return [pscustomobject]@{ BridgeGenerationVerified = $true; Registered = $false; Provider = 'notion2api' }
        }
        $default = $baseline.defaultProvider
        $row = [ordered]@{
            # openai-chat already sends Bearer. OpenCodex's apiKeyTransport override
            # belongs to its anthropic adapter and is rejected on openai-chat.
            adapter = 'openai-chat'; baseUrl = $url; authMode = 'key'
            allowPrivateNetwork = $true; defaultModel = $ModelId
            models = @($ModelId); selectedModels = @($ModelId)
            modelCapabilities = @{ $ModelId = @{ inputModalities = @('text') } }
            disabled = $true
            note = 'Notion2API localhost bridge; connect-opencodex.ps1 registration ' + [Guid]::NewGuid().ToString('N')
        }
        Invoke-SingleProviderChange $baseline $row 'create' $BridgeRoot
        $created = Invoke-OcxCli @('provider', 'snapshot', '--json')
        Assert-OwnedRow $created $row $default
        $beforeKey = Invoke-OcxCli @('account', 'current', 'notion2api', '--json')
        if ($beforeKey.activeId) { throw 'The new provider already has an active key; import refused.' }
        # The secret travels only over redirected stdin, never argv, environment, logs or a temporary file.
        $keyReceipt = Invoke-OcxCli @('account', 'add-key', 'notion2api', '--label', 'Notion2API localhost bridge', '--json') -InputText $key
        if ($keyReceipt.ok -ne $true -or -not $keyReceipt.id) { throw 'Key import did not return a successful receipt.' }
        $activeKey = Invoke-OcxCli @('account', 'current', 'notion2api', '--json')
        if ($activeKey.activeId -cne $keyReceipt.id) { throw 'Imported key is not active; provider will remain disabled.' }
        $enableBaseline = Invoke-OcxCli @('provider', 'snapshot', '--json')
        Assert-OwnedRow $enableBaseline $row $default
        Invoke-SingleProviderChange $enableBaseline $row 'enable' $BridgeRoot
        $row.disabled = $false
        $final = Invoke-OcxCli @('provider', 'snapshot', '--json')
        Assert-OwnedRow $final $row $default
        return [pscustomobject]@{
            BridgeGenerationVerified = $true; Registered = $true; Provider = 'notion2api'
            DefaultProvider = $default; RoutedModel = 'notion2api/' + $ModelId
            OpenCodexGenerationVerified = $false
        }
    } finally { $key = $null }
}

$bridgeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Connect-Notion2Api $bridgeRoot $BaseUrl $Model $OcxPath $TimeoutSeconds ([bool]$Register)
