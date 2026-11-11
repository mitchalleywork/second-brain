[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4177
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskName = 'Work Second Brain'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'Start-SecondBrain.ps1'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userId = $identity.User.Value
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}" -Port {2}' -f $launcher, $nodePath, $Port

$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    $existingUserId = $existing.Principal.UserId
    if ($existingUserId -notmatch '^S-\d-') {
        $account = [System.Security.Principal.NTAccount]::new($existingUserId)
        $existingUserId = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
    if (@($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ne $powerShell -or
        -not $existing.Actions[0].Arguments.Contains('"' + $launcher + '"') -or
        $existingUserId -ne $userId) {
        throw "The task '$taskName' already exists with a different owner or action. It will not be overwritten."
    }
}

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$trigger.Delay = 'PT15S'
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

if ($PSCmdlet.ShouldProcess($taskName, 'Register a least-privilege sign-in task for the current user')) {
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Starts the local Second Brain dashboard and opens it after Windows sign-in.' `
        -Force | Out-Null
    Write-Host "Installed '$taskName'. The dashboard will open about 15 seconds after your next sign-in."
    Write-Host "Start it now with: Start-ScheduledTask -TaskName '$taskName'"
}
