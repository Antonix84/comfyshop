[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Force,
    [switch]$EnableDeveloperMode,
    [string]$UxpRoot = (Join-Path $env:APPDATA 'Adobe\UXP')
)

$ErrorActionPreference = 'Stop'

$pluginId = 'com.comfyshop.panel'
$pluginName = 'ComfyShop'

# Resolve the plugin source both when run from tools/ and when run from the
# repository root via install.bat.
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'plugin'
if (-not (Test-Path (Join-Path $source 'manifest.json'))) {
    $source = Join-Path $PSScriptRoot 'plugin'
}
$manifestPath = Join-Path $source 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "Cannot find plugin/manifest.json. Run install.bat from the repository root."
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$pluginDirName = "${pluginId}_$version"

$externalRoot = Join-Path $UxpRoot 'Plugins\External'
$target = Join-Path $externalRoot $pluginDirName
$infoPath = Join-Path $UxpRoot 'PluginsInfo\v1\PS.json'

function Read-PluginInfo {
    if (Test-Path $infoPath) {
        try {
            return Get-Content $infoPath -Raw | ConvertFrom-Json
        }
        catch {
            Write-Warning "Could not parse $infoPath; it will be recreated."
        }
    }
    return [pscustomobject]@{ plugins = @() }
}

function Write-PluginInfo($info) {
    $dir = Split-Path -Parent $infoPath
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $json = $info | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($infoPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ExistingPlugins($info) {
    if ($info -and $info.PSObject.Properties.Name -contains 'plugins') {
        return @($info.plugins | Where-Object { $_ -and $_.pluginId })
    }
    return @()
}

if ($Uninstall) {
    if (Test-Path $target) {
        Remove-Item $target -Recurse -Force
        Write-Host "Removed $target"
    }
    $info = Read-PluginInfo
    $remaining = @(Get-ExistingPlugins $info | Where-Object { $_.pluginId -ne $pluginId })
    Write-PluginInfo ([pscustomobject]@{ plugins = $remaining })
    Write-Host "ComfyShop uninstalled."
    exit 0
}

if (-not $Force -and (Get-Process Photoshop -ErrorAction SilentlyContinue)) {
    Write-Warning "Photoshop is running. Close it before installing or updating the plugin."
    $answer = Read-Host "Continue anyway? (y/N)"
    if ($answer -notmatch '^[yY]') {
        Write-Host "Cancelled."
        exit 1
    }
}

New-Item -ItemType Directory -Path $externalRoot -Force | Out-Null
if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
}
Copy-Item $source $target -Recurse -Force

$entry = [pscustomobject]@{
    hostMinVersion = '25.0.0'
    name           = $pluginName
    path           = '$localPlugins\External\' + $pluginDirName
    pluginId       = $pluginId
    status         = 'enabled'
    type           = 'uxp'
    versionString  = $version
}

$info = Read-PluginInfo
$others = @(Get-ExistingPlugins $info | Where-Object { $_.pluginId -ne $pluginId })
Write-PluginInfo ([pscustomobject]@{ plugins = @($others + $entry) })

if ($EnableDeveloperMode) {
    $developerDir = Join-Path $env:CommonProgramFiles 'Adobe\UXP\Developer'
    $developerSettings = Join-Path $developerDir 'settings.json'
    $payload = '{"developer": true}'
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        New-Item -ItemType Directory -Path $developerDir -Force | Out-Null
        [System.IO.File]::WriteAllText($developerSettings, $payload, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "UXP Developer Mode enabled."
    }
    else {
        Write-Warning "Enabling UXP Developer Mode needs administrator rights."
        Write-Warning "Alternatively enable it once in the UXP Developer Tool, then restart Photoshop."
    }
}

$developerSettings = Join-Path $env:CommonProgramFiles 'Adobe\UXP\Developer\settings.json'
if (-not (Test-Path $developerSettings)) {
    Write-Warning "UXP Developer Mode does not look enabled. Enable it once in the UXP Developer Tool,"
    Write-Warning "or run this installer as administrator with -EnableDeveloperMode."
}

Write-Host ""
Write-Host "Installed $pluginName $version"
Write-Host "  plugin:       $target"
Write-Host "  registration: $infoPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Make sure UXP Developer Mode is enabled."
Write-Host "  2. Restart Photoshop."
Write-Host "  3. Open Plugins > ComfyShop (or the Plugins panel)."
Write-Host "  4. Open Settings, set the ComfyUI server, press Connect."
