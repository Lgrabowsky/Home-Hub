<#
  Home Hub in VirtualBox: starten, beenden, Zustand anzeigen.
  Für Windows 7 (Windows PowerShell 2.0) und neuer. Anleitung: docs/VIRTUELLE-MASCHINE.md

    Hub-VM starten.cmd   startet die VM unsichtbar im Hintergrund. Dieses Fenster legt sich
                         minimiert in die Taskleiste und hält den PC wach, solange die VM läuft.
    Hub-VM beenden.cmd   fährt die VM sauber herunter. Danach ist ihr Arbeitsspeicher wieder
                         frei, und vom Hub läuft auf dem PC nichts mehr.

  Dauerhaft ändert dieses Skript nichts an Windows: keine Energieeinstellung, kein Autostart,
  kein Dienst. Die Sperre gegen den Energiesparmodus gilt nur, solange das Fenster offen ist.

  Bewusst nur PowerShell-2.0-Sprachmittel (Windows 7): kein [ordered], kein ::new(), kein -in,
  kein [pscustomobject], keine .Where()/.ForEach()-Methoden.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action,

    [string]$VmName = 'HomeHub'
)

# Für die automatischen Tests lassen sich die Wartezeiten verkürzen.
$PollSeconds = 20
if ($env:HOMEHUB_VM_POLL_SECONDS) { $PollSeconds = [int]$env:HOMEHUB_VM_POLL_SECONDS }
$StopPollSeconds = 3
if ($env:HOMEHUB_VM_STOP_POLL_SECONDS) { $StopPollSeconds = [int]$env:HOMEHUB_VM_STOP_POLL_SECONDS }
$StopTimeoutSeconds = 180
$ReadSeconds = 5
if ($env:HOMEHUB_VM_READ_SECONDS) { $ReadSeconds = [int]$env:HOMEHUB_VM_READ_SECONDS }

# Zustände, in denen die VM keinen Arbeitsspeicher mehr belegt.
$OffStates = @('poweroff', 'aborted', 'saved', 'teleported', 'aborted-saved')

# SetThreadExecutionState: ES_CONTINUOUS | ES_SYSTEM_REQUIRED hält den PC wach, ES_CONTINUOUS
# allein gibt ihn wieder frei. Der Bildschirm darf trotzdem ausgehen.
$KeepAwake = [uint32]2147483649
$AllowSleep = [uint32]2147483648

function Write-Problem([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Yellow
}

function Find-VBoxManage {
    $paths = @()
    if ($env:HOMEHUB_VBOXMANAGE) { $paths += $env:HOMEHUB_VBOXMANAGE }
    if ($env:VBOX_MSI_INSTALL_PATH) { $paths += (Join-Path $env:VBOX_MSI_INSTALL_PATH 'VBoxManage.exe') }
    if ($env:ProgramFiles) { $paths += (Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe') }
    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

# Ruft VBoxManage auf und liefert seine Ausgabe (auch Fehlermeldungen) als Textzeilen.
function Invoke-VBox([string[]]$Arguments) {
    $output = & $script:VBoxManage $Arguments 2>&1
    $script:VBoxExit = $LASTEXITCODE
    $lines = @()
    foreach ($item in $output) {
        if ($item -ne $null) { $lines += [string]$item }
    }
    return $lines
}

function Get-VmState {
    $lines = Invoke-VBox @('showvminfo', $VmName, '--machinereadable')
    if ($script:VBoxExit -ne 0) { return 'missing' }
    foreach ($line in $lines) {
        if ($line -match '^VMState="([^"]+)"') { return $matches[1] }
    }
    return 'unknown'
}

function Test-Off([string]$State) {
    return ($OffStates -contains $State)
}

function Exit-Missing {
    Write-Problem "In VirtualBox gibt es keine VM mit dem Namen $VmName."
    Write-Host 'Lege sie an wie in der Anleitung beschrieben (Schritt 4) - der Name muss genau so lauten.'
    exit 1
}

# Windows-Funktionen für "wach halten" und "Fenster minimieren".
function Get-Native {
    $signature = @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
    try {
        return Add-Type -MemberDefinition $signature -Name 'Native' -Namespace 'HomeHubVm' -PassThru
    } catch {
        return $null
    }
}

function Wait-WhileRunning {
    $native = Get-Native
    try { $Host.UI.RawUI.WindowTitle = 'Home Hub läuft - dieses Fenster offen lassen' } catch { }
    Write-Host ''
    Write-Host 'Der Home Hub läuft.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Dieses Fenster hält den PC wach, solange der Hub läuft, und schließt sich von'
    Write-Host 'selbst, sobald die VM aus ist. Bitte nicht schließen - es legt sich gleich'
    Write-Host 'minimiert in die Taskleiste.'
    Write-Host ''
    Write-Host 'Beenden: Doppelklick auf "Hub-VM beenden".'
    Write-Host 'Vor dem Herunterfahren, Neustarten oder Abmelden von Windows immer zuerst den'
    Write-Host 'Hub beenden.'

    $awake = $false
    if ($native) {
        $awake = ($native::SetThreadExecutionState($KeepAwake) -ne 0)
    }
    if (-not $awake) {
        Write-Problem 'Hinweis: Der Energiesparmodus ließ sich nicht abschalten. Geht der PC schlafen,'
        Write-Host 'pausiert auch der Hub.'
    }

    try {
        if ($native -and -not $env:HOMEHUB_VM_NO_MINIMIZE) {
            Start-Sleep -Seconds 8
            $window = $native::GetConsoleWindow()
            if ($window -ne [System.IntPtr]::Zero) { [void]$native::ShowWindow($window, 6) }
        }
        while ($true) {
            $state = Get-VmState
            if ((Test-Off $state) -or ($state -eq 'missing')) { break }
            Start-Sleep -Seconds $PollSeconds
        }
    } finally {
        if ($awake) { [void]$native::SetThreadExecutionState($AllowSleep) }
    }
}

function Start-Hub {
    $state = Get-VmState
    if ($state -eq 'missing') { Exit-Missing }

    if ($state -eq 'paused') {
        [void](Invoke-VBox @('controlvm', $VmName, 'resume'))
    } elseif (Test-Off $state) {
        Write-Host "Die VM $VmName startet ..."
        $output = Invoke-VBox @('startvm', $VmName, '--type', 'headless')
        if ($script:VBoxExit -ne 0) {
            Write-Problem 'Die VM ließ sich nicht starten. VirtualBox meldet:'
            foreach ($line in $output) {
                if ($line) { Write-Host "  $line" }
            }
            if (($output -join ' ') -match 'VT-x|AMD-V|VERR_VMX|VERR_SVM') {
                Write-Host ''
                Write-Host 'Die Virtualisierung ist im BIOS ausgeschaltet. Schalte dort "Intel Virtualization'
                Write-Host 'Technology" (VT-x) ein - siehe Anleitung, Abschnitt Fehlerbehebung.'
            }
            exit 1
        }
    } else {
        Write-Host "Die VM $VmName läuft schon."
    }
    Wait-WhileRunning
}

function Stop-Hub {
    $state = Get-VmState
    if ($state -eq 'missing') { Exit-Missing }
    if (Test-Off $state) {
        Write-Host "Die VM $VmName läuft nicht - es ist nichts zu tun."
        Start-Sleep -Seconds $ReadSeconds
        return
    }
    # Eine pausierte VM reagiert nicht auf den Ausschaltknopf.
    if ($state -eq 'paused') { [void](Invoke-VBox @('controlvm', $VmName, 'resume')) }

    Write-Host "Die VM $VmName fährt herunter (meist in weniger als einer Minute) ..."
    [void](Invoke-VBox @('controlvm', $VmName, 'acpipowerbutton'))

    $waited = 0
    while ($waited -lt $StopTimeoutSeconds) {
        Start-Sleep -Seconds $StopPollSeconds
        $waited += $StopPollSeconds
        if (Test-Off (Get-VmState)) {
            Write-Host ''
            Write-Host 'Der Hub ist beendet. Der Arbeitsspeicher ist wieder frei.' -ForegroundColor Green
            Start-Sleep -Seconds $ReadSeconds
            return
        }
    }

    Write-Problem 'Die VM reagiert nicht auf das Herunterfahren.'
    $answer = Read-Host 'Hart ausschalten? Das ist wie Stecker ziehen. (j/n)'
    if ($answer -notmatch '^[jJyY]') { exit 1 }
    [void](Invoke-VBox @('controlvm', $VmName, 'poweroff'))
    if (-not (Test-Off (Get-VmState))) {
        Write-Problem 'Ausschalten hat nicht geklappt. Öffne VirtualBox und schalte die VM dort aus.'
        exit 1
    }
    Write-Host 'Die VM ist aus.'
}

function Show-Status {
    $state = Get-VmState
    $text = "Zustand: $state"
    switch ($state) {
        'running' { $text = 'Der Hub läuft.' }
        'poweroff' { $text = 'Der Hub ist aus.' }
        'paused' { $text = 'Der Hub ist pausiert (z. B. nach dem Energiesparmodus). "Hub-VM starten" setzt ihn fort.' }
        'saved' { $text = 'Der Hub ist gespeichert und belegt keinen Arbeitsspeicher. "Hub-VM starten" setzt ihn fort.' }
        'aborted' { $text = 'Der Hub ist aus (er wurde zuletzt nicht sauber heruntergefahren).' }
        'missing' { Exit-Missing }
    }
    Write-Host $text
}

$script:VBoxExit = 0
$script:VBoxManage = Find-VBoxManage
if (-not $script:VBoxManage) {
    Write-Problem 'VirtualBox ist nicht installiert (VBoxManage.exe nicht gefunden).'
    Write-Host 'Installiere es wie in der Anleitung beschrieben (Schritt 2).'
    exit 1
}

switch ($Action) {
    'start' { Start-Hub }
    'stop' { Stop-Hub }
    'status' { Show-Status }
}
exit 0
