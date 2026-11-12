param([switch]$Editor)
$ErrorActionPreference='Stop'
$kitRoot=$PSScriptRoot
$runtime=Join-Path $kitRoot 'runtime\electron.exe'
$addon=Join-Path $kitRoot 'tabletop\addon'
$godot=Join-Path $kitRoot 'godot\Godot_v4.7.2-stable_win64.exe'
$artwork=$addon
$installedArtwork=Join-Path $env:APPDATA 'open-dungeon-master-client-dev\local-server\data\addons\packages\comdat-tabletop'
if(Test-Path -LiteralPath (Join-Path $installedArtwork 'ui\assets.json')){$artwork=$installedArtwork}
$env:ODM_ARTWORK_ROOT=$artwork
$env:ELECTRON_RUN_AS_NODE=$null
if($Editor){
  Start-Process -FilePath $runtime -ArgumentList ('"'+(Join-Path $kitRoot 'tabletop\editor')+'"') -WorkingDirectory $kitRoot
  exit
}
$settings=Join-Path $kitRoot 'settings'
[void][IO.Directory]::CreateDirectory($settings)
$config=Join-Path $settings 'native-board.json'
$registration=@{addonId='comdat-tabletop';viewId='table';root=$addon;entry='native/main.mjs';settings=@{godot=$godot;artworkRoot=$artwork}}
$registration.viewId='tabletop'
$original=Get-Content -LiteralPath (Join-Path $addon 'addon.json') -Raw | ConvertFrom-Json
$view=$original.contributes.boardViews | Select-Object -First 1
if($view.id){$registration.viewId=$view.id}
$registration | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $config -Encoding utf8
$env:ODM_NATIVE_BOARD_DEV_CONFIG=$config
$env:ODM_ADDON_DEV_DIRS=$addon
$env:ODM_SERVER_DIR=$null
Start-Process -FilePath $runtime -ArgumentList ('"'+(Join-Path $kitRoot 'client')+'"') -WorkingDirectory $kitRoot

