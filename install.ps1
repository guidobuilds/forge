$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DestinationDir = Join-Path $env:APPDATA 'opencode\agents'
$ManagedFiles = @(
    'forge.md'
    'forge-explore.md'
    'forge-spec.md'
    'forge-plan.md'
    'forge-build.md'
)

foreach ($file in $ManagedFiles) {
    $sourcePath = Join-Path $ScriptDir (Join-Path 'agents' $file)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        Write-Error "Missing required source file: $sourcePath"
    }
}

New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null

foreach ($file in $ManagedFiles) {
    $sourcePath = Join-Path $ScriptDir (Join-Path 'agents' $file)
    $destinationPath = Join-Path $DestinationDir $file
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

Write-Host "Installed Forge agents to $DestinationDir"
