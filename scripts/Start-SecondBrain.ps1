[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4177,
    [string]$NodePath,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtime = Join-Path $root '.runtime'
$url = "http://127.0.0.1:$Port"
$serverProcess = $null
$serverJob = $null

function Write-StartupLog {
    param([string]$Message)
    Add-Content -LiteralPath (Join-Path $runtime 'startup.log') -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}

function Test-WorkspaceReady {
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
    } catch [System.Net.WebException] {
        if ($null -ne $_.Exception.Response) {
            throw "Port $Port responded, but is not a compatible Second Brain server. Check the existing listener before retrying."
        }
        if ($_.Exception.Status -in @([System.Net.WebExceptionStatus]::ConnectFailure, [System.Net.WebExceptionStatus]::Timeout)) {
            return $false
        }
        throw
    }
    if ($health.application -ne 'work-second-brain' -or $health.status -ne 'ready' -or
        -not [string]::Equals($health.workspaceRoot, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Port $Port belongs to a different application or workspace. It will not be stopped or replaced."
    }
    return $true
}

try {
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Write-StartupLog "Starting launcher on port $Port."
    $ready = Test-WorkspaceReady
    if ($ready) {
        Write-StartupLog 'Reusing the existing healthy workspace server.'
    } else {
        if (-not $NodePath) {
            $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
        }
        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            throw "Node.js was not found at $NodePath. Reinstall the sign-in task after fixing the Node.js installation."
        }
        if (-not ('SecondBrain.StartupJob' -as [type])) {
            Add-Type -Path (Join-Path $PSScriptRoot 'StartupJob.cs')
        }
        $serverJob = [SecondBrain.StartupJob]::Create()
        $previousPort = $env:PORT
        try {
            $env:PORT = [string]$Port
            $serverProcess = Start-Process -FilePath $NodePath -ArgumentList '"server.js"' -WorkingDirectory $root `
                -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'server.log') `
                -RedirectStandardError (Join-Path $runtime 'server-error.log') -PassThru
            [SecondBrain.StartupJob]::Assign($serverJob, $serverProcess.Handle)
        } finally {
            if ($null -eq $previousPort) {
                Remove-Item Env:\PORT -ErrorAction SilentlyContinue
            } else {
                $env:PORT = $previousPort
            }
        }
        Write-StartupLog "Started Node.js process $($serverProcess.Id)."
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            if ($serverProcess.HasExited) {
                throw "The server exited before becoming ready. Read .runtime\server-error.log."
            }
            $ready = Test-WorkspaceReady
            if (-not $ready) {
                Start-Sleep -Milliseconds 500
            }
        } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
        if (-not $ready) {
            throw 'The server was not ready within 45 seconds. Read .runtime\server-error.log.'
        }
    }

    Write-StartupLog "Workspace ready at $url."
    if (-not $NoBrowser) {
        Start-Process -FilePath $url
        Write-StartupLog 'Opened the dashboard in the default browser.'
    }
    if ($null -ne $serverProcess) {
        $serverProcess.WaitForExit()
        $exitCode = $serverProcess.ExitCode
        Write-StartupLog "Server exited with code $exitCode."
        exit $exitCode
    }
    exit 0
} catch {
    $message = $_.Exception.Message
    if (Test-Path -LiteralPath $runtime -PathType Container) {
        Write-StartupLog "ERROR: $message"
    }
    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -ErrorAction Continue
    }
    Write-Error -Message $message -ErrorAction Continue
    exit 1
} finally {
    if ($null -ne $serverJob) {
        $serverJob.Dispose()
    }
}
