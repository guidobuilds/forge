$ErrorActionPreference = 'Stop'

$ForgeRepo = if ($env:FORGE_REPO) { $env:FORGE_REPO } else { 'guidobuilds/forge' }
$ForgeRef = if ($env:FORGE_REF) { $env:FORGE_REF } else { 'main' }
$RawBase = "https://raw.githubusercontent.com/$ForgeRepo/refs/heads/$ForgeRef"

$AgentFiles = @('forge.md', 'forge-worker.md')
$SkillDirs = @('using-forge', 'forge-worker', 'forge-explore', 'forge-design', 'forge-plan', 'forge-build', 'forge-helper')

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { '' }

function Test-LocalSources {
    return ($ScriptDir -and (Test-Path -LiteralPath (Join-Path $ScriptDir 'agents') -PathType Container) -and (Test-Path -LiteralPath (Join-Path $ScriptDir 'skills') -PathType Container))
}

function Copy-OrFetchFile {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestPath
    )

    $DestParent = Split-Path -Parent $DestPath
    New-Item -ItemType Directory -Force -Path $DestParent | Out-Null

    $LocalPath = if ($ScriptDir) { Join-Path $ScriptDir $SourcePath } else { '' }
    if ((Test-LocalSources) -and (Test-Path -LiteralPath $LocalPath -PathType Leaf)) {
        Copy-Item -LiteralPath $LocalPath -Destination $DestPath -Force
    } else {
        Invoke-WebRequest -UseBasicParsing "$RawBase/$SourcePath" -OutFile $DestPath
    }
}

function Clear-ForgeDestination {
    param(
        [Parameter(Mandatory = $true)][string]$AgentsDir,
        [Parameter(Mandatory = $true)][string]$SkillsDir
    )

    New-Item -ItemType Directory -Force -Path $AgentsDir, $SkillsDir | Out-Null

    Get-ChildItem -LiteralPath $AgentsDir -Filter 'forge*.md' -File -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem -LiteralPath $SkillsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'forge*' -or $_.Name -eq 'using-forge' } | Remove-Item -Recurse -Force
}

function Install-ForgeTo {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$AgentsDir,
        [Parameter(Mandatory = $true)][string]$SkillsDir
    )

    Clear-ForgeDestination -AgentsDir $AgentsDir -SkillsDir $SkillsDir

    foreach ($Agent in $AgentFiles) {
        Copy-OrFetchFile -SourcePath "agents/$Agent" -DestPath (Join-Path $AgentsDir $Agent)
    }

    foreach ($Skill in $SkillDirs) {
        Copy-OrFetchFile -SourcePath "skills/$Skill/SKILL.md" -DestPath (Join-Path (Join-Path $SkillsDir $Skill) 'SKILL.md')
    }

    Write-Host "Installed Forge for ${Name}:"
    Write-Host "  $AgentsDir"
    Write-Host "  $SkillsDir"
}

$AppData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Roaming' }
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }

Install-ForgeTo -Name 'OpenCode' -AgentsDir (Join-Path $AppData 'opencode\agents') -SkillsDir (Join-Path $AppData 'opencode\skills')
Install-ForgeTo -Name 'Codex' -AgentsDir (Join-Path $UserHome '.codex\agents') -SkillsDir (Join-Path $UserHome '.codex\skills')
Install-ForgeTo -Name 'Claude Code' -AgentsDir (Join-Path $UserHome '.claude\agents') -SkillsDir (Join-Path $UserHome '.claude\skills')
