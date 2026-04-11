param(
    [string]$Ref = $env:FORGE_REF,
    [string]$ManifestUrl = $env:FORGE_MANIFEST_URL
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ManifestName = 'install-manifest.env'
$LegacyAgents = @('forge-spec.md', 'forge-tech.md')
if (-not $ManifestUrl) {
    $ManifestUrl = "https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/$ManifestName"
}

function Get-ForgeManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $manifest = @{}

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) {
            continue
        }

        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) {
            throw "Invalid manifest entry in $Path`: $line"
        }

        $manifest[$parts[0]] = $parts[1]
    }

    foreach ($key in 'OWNER', 'REPO', 'DEFAULT_REF', 'AGENTS', 'SKILLS') {
        if (-not $manifest.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($manifest[$key])) {
            throw "Missing $key in $Path"
        }
    }

    return $manifest
}

function Save-ForgeDownload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing | Out-Null
    }
    catch {
        throw "Failed to download $Url. $($_.Exception.Message)"
    }
}

function Install-ForgeManagedFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Files,
        [Parameter(Mandatory = $true)]
        [string]$SourceDirName,
        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot,
        [string]$LocalSourceRoot,
        [Parameter(Mandatory = $true)]
        [string]$RawBaseUrl,
        [Parameter(Mandatory = $true)]
        [string]$TempDir,
        [Parameter(Mandatory = $true)]
        [bool]$UseLocalSources
    )

    foreach ($file in $Files) {
        $stagedPath = Join-Path $TempDir $file
        $stagedDir = Split-Path -Parent $stagedPath
        if ($stagedDir) {
            New-Item -ItemType Directory -Path $stagedDir -Force | Out-Null
        }

        if ($UseLocalSources) {
            $sourcePath = Join-Path $LocalSourceRoot $file
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                throw "Missing required source file: $sourcePath"
            }

            Copy-Item -LiteralPath $sourcePath -Destination $stagedPath -Force
        }
        else {
            $sourceUrl = "$RawBaseUrl/$SourceDirName/$file"
            Save-ForgeDownload -Url $sourceUrl -Destination $stagedPath
        }

        $destinationPath = Join-Path $DestinationRoot $file
        $destinationDir = Split-Path -Parent $destinationPath
        if ($destinationDir) {
            New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
        }

        Move-Item -LiteralPath $stagedPath -Destination $destinationPath -Force
    }
}

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir = $null
if ($ScriptPath) {
    $ScriptDir = Split-Path -Parent $ScriptPath
}

$LocalMode = $false
$LocalManifestPath = $null
$LocalAgentsDir = $null
$LocalSkillsDir = $null
if ($ScriptDir) {
    $candidateManifest = Join-Path $ScriptDir $ManifestName
    $candidateAgentsDir = Join-Path $ScriptDir 'agents'
    $candidateSkillsDir = Join-Path $ScriptDir 'skills'
    if ((Test-Path -LiteralPath $candidateManifest -PathType Leaf) -and (Test-Path -LiteralPath $candidateAgentsDir -PathType Container) -and (Test-Path -LiteralPath $candidateSkillsDir -PathType Container)) {
        $LocalMode = $true
        $LocalManifestPath = $candidateManifest
        $LocalAgentsDir = $candidateAgentsDir
        $LocalSkillsDir = $candidateSkillsDir
    }
}

if (-not $env:APPDATA) {
    throw 'APPDATA is not set.'
}

$AgentsDestinationDir = Join-Path $env:APPDATA 'opencode\agents'
$SkillsDestinationDir = Join-Path $env:APPDATA 'opencode\skills'
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $ManifestPath = Join-Path $TempDir $ManifestName

    if ($LocalMode) {
        Copy-Item -LiteralPath $LocalManifestPath -Destination $ManifestPath -Force
    }
    else {
        Save-ForgeDownload -Url $ManifestUrl -Destination $ManifestPath
    }

    $Manifest = Get-ForgeManifest -Path $ManifestPath
    $SelectedRef = if ($Ref) { $Ref } else { $Manifest['DEFAULT_REF'] }
    $RawBaseUrl = "https://raw.githubusercontent.com/$($Manifest['OWNER'])/$($Manifest['REPO'])/$SelectedRef"
    $ManagedAgents = $Manifest['AGENTS'] -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $ManagedSkills = $Manifest['SKILLS'] -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    if ($ManagedAgents.Count -eq 0) {
        throw "Missing agent entries in $ManifestPath"
    }

    if ($ManagedSkills.Count -eq 0) {
        throw "Missing skill entries in $ManifestPath"
    }

    New-Item -ItemType Directory -Path $AgentsDestinationDir -Force | Out-Null
    New-Item -ItemType Directory -Path $SkillsDestinationDir -Force | Out-Null

    Install-ForgeManagedFiles -Files $ManagedAgents -SourceDirName 'agents' -DestinationRoot $AgentsDestinationDir -LocalSourceRoot $LocalAgentsDir -RawBaseUrl $RawBaseUrl -TempDir $TempDir -UseLocalSources $LocalMode
    Install-ForgeManagedFiles -Files $ManagedSkills -SourceDirName 'skills' -DestinationRoot $SkillsDestinationDir -LocalSourceRoot $LocalSkillsDir -RawBaseUrl $RawBaseUrl -TempDir $TempDir -UseLocalSources $LocalMode

    foreach ($file in $LegacyAgents) {
        $legacyPath = Join-Path $AgentsDestinationDir $file
        if (Test-Path -LiteralPath $legacyPath -PathType Leaf) {
            Remove-Item -LiteralPath $legacyPath -Force
        }
    }

    Write-Host "Installed Forge agents to $AgentsDestinationDir"
    Write-Host "Installed Forge skills to $SkillsDestinationDir"
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
}
