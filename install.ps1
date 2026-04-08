param(
    [string]$Ref = $env:FORGE_REF,
    [string]$ManifestUrl = $env:FORGE_MANIFEST_URL
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ManifestName = 'install-manifest.env'
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

    foreach ($key in 'OWNER', 'REPO', 'DEFAULT_REF', 'AGENTS') {
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

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir = $null
if ($ScriptPath) {
    $ScriptDir = Split-Path -Parent $ScriptPath
}

$LocalMode = $false
$LocalManifestPath = $null
$LocalAgentsDir = $null
if ($ScriptDir) {
    $candidateManifest = Join-Path $ScriptDir $ManifestName
    $candidateAgentsDir = Join-Path $ScriptDir 'agents'
    if ((Test-Path -LiteralPath $candidateManifest -PathType Leaf) -and (Test-Path -LiteralPath $candidateAgentsDir -PathType Container)) {
        $LocalMode = $true
        $LocalManifestPath = $candidateManifest
        $LocalAgentsDir = $candidateAgentsDir
    }
}

if (-not $env:APPDATA) {
    throw 'APPDATA is not set.'
}

$DestinationDir = Join-Path $env:APPDATA 'opencode\agents'
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
    $ManagedFiles = $Manifest['AGENTS'] -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    if ($ManagedFiles.Count -eq 0) {
        throw "Missing agent entries in $ManifestPath"
    }

    New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null

    foreach ($file in $ManagedFiles) {
        $stagedPath = Join-Path $TempDir $file

        if ($LocalMode) {
            $sourcePath = Join-Path $LocalAgentsDir $file
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                throw "Missing required source file: $sourcePath"
            }

            Copy-Item -LiteralPath $sourcePath -Destination $stagedPath -Force
        }
        else {
            $sourceUrl = "$RawBaseUrl/agents/$file"
            Save-ForgeDownload -Url $sourceUrl -Destination $stagedPath
        }

        $destinationPath = Join-Path $DestinationDir $file
        Move-Item -LiteralPath $stagedPath -Destination $destinationPath -Force
    }

    Write-Host "Installed Forge agents to $DestinationDir"
}
finally {
    if (Test-Path -LiteralPath $TempDir) {
        Remove-Item -LiteralPath $TempDir -Recurse -Force
    }
}
