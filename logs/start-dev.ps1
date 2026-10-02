
$env:HERMES_KEY='y6GuwLJtTC6LlPspydcdKyHZiBio6xUutkVdc4eV-6U'
$env:PORT='8124'
Set-Location C:\git\hermes-mobile-v2
Start-Process node -ArgumentList 'server/server.js' -RedirectStandardOutput logs\dev-server.log -RedirectStandardError logs\dev-server.err.log -WindowStyle Hidden
