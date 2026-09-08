<#
.SYNOPSIS
  Runs the DSH harness CLI from an ordinary shell.

.DESCRIPTION
  `dsh` is not a program. It is a .cmd shim that runs the Desktop app's own
  Electron binary as Node against a bootstrap script inside `app.asar`, and it
  reads both paths out of environment variables the app injects when it spawns
  its terminal. So the command works in the DSH Terminal and nowhere else —
  which makes every plugin install a manual step, and manual steps are the ones
  that get skipped before a demo.

  This reconstructs those two variables and calls the same entry point. It is
  the same CLI, not a reimplementation: the shim is four lines and this is
  those four lines with the environment supplied.

  `--profile` is required. The app sets a default profile for its own terminal
  and nothing sets one here, so the CLI refuses rather than guessing — which is
  the right refusal, since guessing wrong would modify a profile nobody asked
  about.

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

$app = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\DSH Desktop.exe'
$bootstrap = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app.asar\lib\desktop-cli.js'

if (-not (Test-Path $app)) {
    Write-Error "DSH Desktop is not installed at $app"
    exit 1
}

# The bootstrap lives inside app.asar, so Test-Path cannot see it — Electron
# resolves asar paths itself. Only the archive is checkable.
$archive = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app.asar'
if (-not (Test-Path $archive)) {
    Write-Error "DSH Desktop's app.asar is missing at $archive"
    exit 1
}

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_DESKTOP_APP_EXECUTABLE = $app
$env:DSH_DESKTOP_DSH_BOOTSTRAP = $bootstrap

& $app --expose-internals $bootstrap @Args
exit $LASTEXITCODE
