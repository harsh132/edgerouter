<#
.SYNOPSIS
  Runs the DSH harness CLI from an ordinary shell.

.DESCRIPTION
  `dsh` is not a program. It is a .cmd shim that runs the Desktop app's own
  Electron binary as Node against a bootstrap script inside `app.asar`, and it
  reads every path it needs from environment variables the app injects when it
  spawns its terminal. So the command works in the DSH Terminal and nowhere
  else — which makes every plugin install a manual step, and manual steps are
  the ones that get skipped before a demo.

  This reconstructs that environment and calls the same entry points. It is not
  a reimplementation: the shims are four lines each, and this is those lines
  with their variables supplied.

  Four things are needed, and the fourth is easy to miss. `dsh plugin add`
  shells out to `pnpm`, which is another shim in the same directory and needs
  its own entry path — so the directory goes on PATH and PNPM_ENTRY is set,
  otherwise the install fails with "pnpm is not recognized" after the CLI has
  already started working.

  `--profile` stays required. The app sets a default for its own terminal and
  nothing sets one here, so the CLI refuses rather than guessing — which is the
  right refusal, since a wrong guess would modify a profile nobody asked about.

.EXAMPLE
  ./scripts/dsh.ps1 plugin --profile desktop add "C:/workspace/edgerouter/packages/dsh/dsh-plugin-edgerouter.tgz"

.EXAMPLE
  ./scripts/dsh.ps1 --dump-config --profile desktop
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Args
)

$programs = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop'
$app = Join-Path $programs 'DSH Desktop.exe'
$resources = Join-Path $programs 'resources'
$archive = Join-Path $resources 'app.asar'

if (-not (Test-Path $app)) { Write-Error "DSH Desktop is not installed at $app"; exit 1 }
if (-not (Test-Path $archive)) { Write-Error "DSH Desktop's app.asar is missing at $archive"; exit 1 }

# Paths inside app.asar cannot be Test-Path'd — Electron resolves them itself.
$bootstrap = Join-Path $archive 'lib\desktop-cli.js'
$pnpmEntry = Join-Path $archive 'node_modules\pnpm\bin\pnpm.mjs'

<#
  The shim directory holds dsh.cmd, node.cmd and pnpm.cmd. Only pnpm is
  actually needed on PATH — the CLI calls it by name — but the whole directory
  goes on so that anything else it reaches for resolves the same way the app's
  own terminal would.
#>
$shimRoot = Join-Path $env:APPDATA 'DSH Desktop\cli'
$shimDir = Get-ChildItem $shimRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 |
    ForEach-Object { Join-Path $_.FullName 'bin' }

if (-not $shimDir -or -not (Test-Path $shimDir)) {
    Write-Error "Could not find the DSH CLI shims under $shimRoot. Open the DSH Terminal once to create them."
    exit 1
}

# The version the pnpm shim passes as npm_config_target, asked of the runtime
# rather than hardcoded — it changes with every app update.
$env:ELECTRON_RUN_AS_NODE = '1'
$electronVersion = & $app -p 'process.versions.electron'

$env:DSH_DESKTOP_APP_EXECUTABLE = $app
$env:DSH_DESKTOP_DSH_BOOTSTRAP = $bootstrap
$env:DSH_DESKTOP_PNPM_ENTRY = $pnpmEntry
$env:DSH_DESKTOP_ELECTRON_VERSION = $electronVersion
$env:PATH = "$shimDir;$env:PATH"

<#
  Run through Start-Process with the streams redirected to files, then print
  them, rather than calling the app directly.

  Called directly, Electron writes to the console handle and nothing reaches a
  captured pipe — so `dsh plugin add` returns exit 0 with no output whether it
  installed anything or not. A silent success and a silent no-op are the same
  observation, which is how a plugin can appear installed for an hour while the
  old version is still on disk. Redirecting is the only way to see which
  happened.
#>
$outFile = New-TemporaryFile
$errFile = New-TemporaryFile
$quoted = @('--expose-internals', "`"$bootstrap`"") + $Args

$process = Start-Process -FilePath $app -ArgumentList $quoted -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile

Get-Content $outFile -ErrorAction SilentlyContinue
Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue

exit $process.ExitCode
