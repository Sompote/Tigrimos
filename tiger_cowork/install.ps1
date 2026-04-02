# Tiger Cowork - Windows Installer (PowerShell + WPF)
# Shows a themed progress window matching the Mac installer style

param(
    [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$REPO_URL = "https://github.com/Sompote/tiger_cowork.git"
$APP_URL  = "http://localhost:3001"
$PORT     = 3001
$LOG_FILE = "$env:TEMP\tiger-cowork-install.log"

# Load WPF assemblies
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

# ============================================================
# STEP 0: Welcome + Folder Chooser
# ============================================================

# Show welcome dialog with folder chooser
$welcomeXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Tiger Cowork Installer"
        Width="520" Height="440"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize"
        Background="#FF1a1a2e">
    <Window.Resources>
        <Style x:Key="OrangeButton" TargetType="Button">
            <Setter Property="Background">
                <Setter.Value>
                    <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                        <GradientStop Color="#FFf59e0b" Offset="0"/>
                        <GradientStop Color="#FFf97316" Offset="1"/>
                    </LinearGradientBrush>
                </Setter.Value>
            </Setter>
            <Setter Property="Foreground" Value="White"/>
            <Setter Property="FontSize" Value="14"/>
            <Setter Property="FontWeight" Value="SemiBold"/>
            <Setter Property="Padding" Value="24,10"/>
            <Setter Property="BorderThickness" Value="0"/>
            <Setter Property="Cursor" Value="Hand"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="Button">
                        <Border Background="{TemplateBinding Background}"
                                CornerRadius="10"
                                Padding="{TemplateBinding Padding}">
                            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                        </Border>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Window.Resources>
    <Border CornerRadius="0" Background="#FF1a1a2e">
        <Grid>
            <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center" Width="420">
                <!-- Tiger Logo -->
                <TextBlock Text="&#x1F42F;" FontSize="56" HorizontalAlignment="Center" Margin="0,0,0,8"/>
                <TextBlock Text="Tiger Cowork" FontSize="24" FontWeight="SemiBold" Foreground="White"
                           HorizontalAlignment="Center" Margin="0,0,0,4"/>
                <TextBlock Text="Windows Installer" FontSize="13" Foreground="#80FFFFFF"
                           HorizontalAlignment="Center" Margin="0,0,0,24"/>

                <!-- Description -->
                <TextBlock Foreground="#CCFFFFFF" FontSize="13" TextWrapping="Wrap" Margin="0,0,0,6">
                    This installer will:
                </TextBlock>
                <TextBlock Foreground="#AAFFFFFF" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Install Docker Desktop (if needed)"/>
                <TextBlock Foreground="#AAFFFFFF" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Install Git (if needed)"/>
                <TextBlock Foreground="#AAFFFFFF" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Download Tiger Cowork"/>
                <TextBlock Foreground="#AAFFFFFF" FontSize="13" Margin="16,0,0,20" Text="&#x2022; Build and start the app"/>

                <!-- Folder chooser -->
                <TextBlock Text="Install location:" Foreground="#CCFFFFFF" FontSize="13" Margin="0,0,0,6"/>
                <Grid Margin="0,0,0,20">
                    <Grid.ColumnDefinitions>
                        <ColumnDefinition Width="*"/>
                        <ColumnDefinition Width="Auto"/>
                    </Grid.ColumnDefinitions>
                    <TextBox x:Name="PathBox" Grid.Column="0" Text="C:\TigerCowork"
                             FontSize="13" Padding="8,6" Background="#20FFFFFF" Foreground="White"
                             BorderBrush="#30FFFFFF" BorderThickness="1"/>
                    <Button x:Name="BrowseBtn" Grid.Column="1" Content="Browse..."
                            Style="{StaticResource OrangeButton}" Margin="8,0,0,0"
                            FontSize="12" Padding="12,6"/>
                </Grid>

                <!-- Action buttons -->
                <StackPanel Orientation="Horizontal" HorizontalAlignment="Center">
                    <Button x:Name="InstallBtn" Content="Install" Style="{StaticResource OrangeButton}"
                            Padding="36,12" FontSize="16" Margin="0,0,12,0"/>
                    <Button x:Name="CancelBtn" Content="Cancel" Padding="24,12" FontSize="14"
                            Background="Transparent" Foreground="#80FFFFFF" BorderBrush="#40FFFFFF"
                            BorderThickness="1" Cursor="Hand">
                        <Button.Template>
                            <ControlTemplate TargetType="Button">
                                <Border Background="{TemplateBinding Background}"
                                        BorderBrush="{TemplateBinding BorderBrush}"
                                        BorderThickness="{TemplateBinding BorderThickness}"
                                        CornerRadius="10" Padding="{TemplateBinding Padding}">
                                    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                                </Border>
                            </ControlTemplate>
                        </Button.Template>
                    </Button>
                </StackPanel>
            </StackPanel>
        </Grid>
    </Border>
</Window>
"@

$welcomeReader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($welcomeXaml))
$welcomeWindow = [System.Windows.Markup.XamlReader]::Load($welcomeReader)

$pathBox    = $welcomeWindow.FindName("PathBox")
$browseBtn  = $welcomeWindow.FindName("BrowseBtn")
$installBtn = $welcomeWindow.FindName("InstallBtn")
$cancelBtn  = $welcomeWindow.FindName("CancelBtn")

$script:userCancelled = $true

$browseBtn.Add_Click({
    $folderDialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $folderDialog.Description = "Choose install location for Tiger Cowork"
    $folderDialog.SelectedPath = "C:\"
    if ($folderDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $selectedPath = Join-Path $folderDialog.SelectedPath "TigerCowork"
        $pathBox.Text = $selectedPath
    }
})

$installBtn.Add_Click({
    $script:userCancelled = $false
    $script:InstallDir = $pathBox.Text
    $welcomeWindow.Close()
})

$cancelBtn.Add_Click({
    $script:userCancelled = $true
    $welcomeWindow.Close()
})

$welcomeWindow.ShowDialog() | Out-Null

if ($script:userCancelled) {
    exit 0
}

$InstallDir = $script:InstallDir

# ============================================================
# Progress Window
# ============================================================

$stepLabels = @(
    "Check Docker",
    "Start Docker Engine",
    "Check Git",
    "Download Tiger Cowork",
    "Configure",
    "Build & Start Container",
    "Launch App"
)

$progressXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Installing Tiger Cowork"
        Width="560" Height="520"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize"
        Background="#FF1a1a2e">
    <Border CornerRadius="0">
        <Border.Background>
            <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                <GradientStop Color="#FF1a1a2e" Offset="0"/>
                <GradientStop Color="#FF16213e" Offset="0.5"/>
                <GradientStop Color="#FF0f3460" Offset="1"/>
            </LinearGradientBrush>
        </Border.Background>
        <Grid>
            <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center" Width="440">
                <!-- Tiger Logo -->
                <TextBlock Text="&#x1F42F;" FontSize="56" HorizontalAlignment="Center" Margin="0,0,0,8"/>
                <TextBlock Text="Tiger Cowork" FontSize="24" FontWeight="SemiBold" Foreground="White"
                           HorizontalAlignment="Center" Margin="0,0,0,4"/>
                <TextBlock Text="Installer" FontSize="13" Foreground="#80FFFFFF"
                           HorizontalAlignment="Center" Margin="0,0,0,28"/>

                <!-- Progress bar background -->
                <Border Background="#1AFFFFFF" CornerRadius="12" Height="24" Margin="0,0,0,16">
                    <Grid>
                        <Border x:Name="ProgressFill" CornerRadius="12" Height="24"
                                HorizontalAlignment="Left" Width="0">
                            <Border.Background>
                                <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                                    <GradientStop Color="#FFf59e0b" Offset="0"/>
                                    <GradientStop Color="#FFf97316" Offset="1"/>
                                </LinearGradientBrush>
                            </Border.Background>
                            <TextBlock x:Name="ProgressPercent" Text="0%" FontSize="11" FontWeight="Bold"
                                       Foreground="White" HorizontalAlignment="Right" VerticalAlignment="Center"
                                       Margin="0,0,10,0"/>
                        </Border>
                    </Grid>
                </Border>

                <!-- Step title and status -->
                <TextBlock x:Name="StepTitle" Text="Preparing..." FontSize="18" FontWeight="Medium"
                           Foreground="#FFf59e0b" HorizontalAlignment="Center" Margin="0,0,0,4"/>
                <TextBlock x:Name="StepStatus" Text="" FontSize="13" Foreground="#99FFFFFF"
                           HorizontalAlignment="Center" Margin="0,0,0,20"/>

                <!-- Steps checklist -->
                <StackPanel x:Name="StepsList" Margin="0,0,0,0">
                </StackPanel>
            </StackPanel>
        </Grid>
    </Border>
</Window>
"@

$progressReader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($progressXaml))
$progressWindow = [System.Windows.Markup.XamlReader]::Load($progressReader)

$progressFill    = $progressWindow.FindName("ProgressFill")
$progressPercent = $progressWindow.FindName("ProgressPercent")
$stepTitle       = $progressWindow.FindName("StepTitle")
$stepStatus      = $progressWindow.FindName("StepStatus")
$stepsList       = $progressWindow.FindName("StepsList")

# Build step rows
$stepTextBlocks = @()
for ($i = 0; $i -lt $stepLabels.Count; $i++) {
    $sp = New-Object System.Windows.Controls.StackPanel
    $sp.Orientation = "Horizontal"
    $sp.Margin = [System.Windows.Thickness]::new(0, 3, 0, 3)

    $icon = New-Object System.Windows.Controls.TextBlock
    $icon.Width = 24
    $icon.FontSize = 13
    $icon.Text = [char]0x25CB  # circle
    $icon.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#66FFFFFF")
    $icon.VerticalAlignment = "Center"

    $label = New-Object System.Windows.Controls.TextBlock
    $label.Text = "Step $($i+1): $($stepLabels[$i])"
    $label.FontSize = 13
    $label.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#66FFFFFF")
    $label.VerticalAlignment = "Center"

    $sp.Children.Add($icon) | Out-Null
    $sp.Children.Add($label) | Out-Null
    $stepsList.Children.Add($sp) | Out-Null

    $stepTextBlocks += @{ Icon = $icon; Label = $label; Panel = $sp }
}

# ============================================================
# Helper: Update progress UI
# ============================================================
$barMaxWidth = 440

function Update-Progress {
    param([int]$CurrentStep, [int]$TotalSteps, [string]$Title, [string]$Status)

    $percent = [math]::Floor(($CurrentStep * 100) / $TotalSteps)
    $fillWidth = [math]::Floor(($percent / 100) * $barMaxWidth)
    if ($fillWidth -lt 40) { $fillWidth = 40 }

    $progressWindow.Dispatcher.Invoke([Action]{
        $progressFill.Width = $fillWidth
        $progressPercent.Text = "$percent%"
        $stepTitle.Text = $Title
        $stepStatus.Text = $Status

        $greenBrush  = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF4ade80")
        $amberBrush  = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFf59e0b")
        $dimBrush    = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#66FFFFFF")

        for ($i = 0; $i -lt $stepTextBlocks.Count; $i++) {
            $entry = $stepTextBlocks[$i]
            if (($i + 1) -lt $CurrentStep) {
                # Done
                $entry.Icon.Text = [string][char]0x2713
                $entry.Icon.Foreground = $greenBrush
                $entry.Label.Foreground = $greenBrush
                $entry.Label.FontWeight = "Normal"
            } elseif (($i + 1) -eq $CurrentStep) {
                # Active
                $entry.Icon.Text = [string][char]0x27F3
                $entry.Icon.Foreground = $amberBrush
                $entry.Label.Foreground = $amberBrush
                $entry.Label.FontWeight = "SemiBold"
            } else {
                # Pending
                $entry.Icon.Text = [string][char]0x25CB
                $entry.Icon.Foreground = $dimBrush
                $entry.Label.Foreground = $dimBrush
                $entry.Label.FontWeight = "Normal"
            }
        }
    }, [System.Windows.Threading.DispatcherPriority]::Background)
}

# ============================================================
# Helper: Show error
# ============================================================
function Show-InstallerError {
    param([string]$Message)
    [System.Windows.MessageBox]::Show($Message, "Tiger Cowork", "OK", "Error") | Out-Null
}

# ============================================================
# Helper: Find docker.exe
# ============================================================
function Find-Docker {
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($dockerCmd) { return $dockerCmd.Source }
    $paths = @(
        "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
        "$env:LOCALAPPDATA\Docker\resources\bin\docker.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# ============================================================
# Helper: Find git.exe
# ============================================================
function Find-Git {
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) { return $gitCmd.Source }
    $paths = @(
        "$env:ProgramFiles\Git\bin\git.exe",
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\bin\git.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# ============================================================
# Run installation in a background job-like fashion
# We use a dispatcher timer + state machine so WPF stays responsive
# ============================================================

$script:installStep = 0
$script:dockerExe = $null
$script:gitExe = $null
$script:dockerWaitCount = 0

# Show the window first, then start installation via Dispatcher
$progressWindow.Add_ContentRendered({
    # Run the entire install in a background runspace so UI stays responsive
    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.ApartmentState = "STA"
    $runspace.Open()

    $ps = [powershell]::Create()
    $ps.Runspace = $runspace

    # Pass variables into the runspace
    $ps.AddScript({
        param($progressWindow, $progressFill, $progressPercent, $stepTitle, $stepStatus,
              $stepTextBlocks, $barMaxWidth, $InstallDir, $REPO_URL, $APP_URL, $PORT, $LOG_FILE, $stepLabels)

        function Update-ProgressInner {
            param([int]$CurrentStep, [int]$TotalSteps, [string]$Title, [string]$Status)
            $percent = [math]::Floor(($CurrentStep * 100) / $TotalSteps)
            $fillWidth = [math]::Floor(($percent / 100) * $barMaxWidth)
            if ($fillWidth -lt 40) { $fillWidth = 40 }

            $progressWindow.Dispatcher.Invoke([Action]{
                $progressFill.Width = $fillWidth
                $progressPercent.Text = "$percent%"
                $stepTitle.Text = $Title
                $stepStatus.Text = $Status

                $greenBrush  = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF4ade80")
                $amberBrush  = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFf59e0b")
                $dimBrush    = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#66FFFFFF")

                for ($i = 0; $i -lt $stepTextBlocks.Count; $i++) {
                    $entry = $stepTextBlocks[$i]
                    if (($i + 1) -lt $CurrentStep) {
                        $entry.Icon.Text = [string][char]0x2713
                        $entry.Icon.Foreground = $greenBrush
                        $entry.Label.Foreground = $greenBrush
                        $entry.Label.FontWeight = "Normal"
                    } elseif (($i + 1) -eq $CurrentStep) {
                        $entry.Icon.Text = [string][char]0x27F3
                        $entry.Icon.Foreground = $amberBrush
                        $entry.Label.Foreground = $amberBrush
                        $entry.Label.FontWeight = "SemiBold"
                    } else {
                        $entry.Icon.Text = [string][char]0x25CB
                        $entry.Icon.Foreground = $dimBrush
                        $entry.Label.Foreground = $dimBrush
                        $entry.Label.FontWeight = "Normal"
                    }
                }
            }, [System.Windows.Threading.DispatcherPriority]::Background)
        }

        function Find-DockerInner {
            $dockerCmd = $null
            try { $dockerCmd = (Get-Command docker -ErrorAction SilentlyContinue).Source } catch {}
            if ($dockerCmd) { return $dockerCmd }
            $paths = @(
                "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
                "$env:LOCALAPPDATA\Docker\resources\bin\docker.exe"
            )
            foreach ($p in $paths) { if (Test-Path $p) { return $p } }
            return $null
        }

        function Find-GitInner {
            $gitCmd = $null
            try { $gitCmd = (Get-Command git -ErrorAction SilentlyContinue).Source } catch {}
            if ($gitCmd) { return $gitCmd }
            $paths = @(
                "$env:ProgramFiles\Git\bin\git.exe",
                "$env:ProgramFiles\Git\cmd\git.exe",
                "${env:ProgramFiles(x86)}\Git\bin\git.exe"
            )
            foreach ($p in $paths) { if (Test-Path $p) { return $p } }
            return $null
        }

        function Show-Error {
            param([string]$msg)
            $progressWindow.Dispatcher.Invoke([Action]{
                [System.Windows.MessageBox]::Show($progressWindow, $msg, "Tiger Cowork", "OK", "Error") | Out-Null
            })
        }

        function Show-Completion {
            $progressWindow.Dispatcher.Invoke([Action]{
                $progressFill.Width = $barMaxWidth
                $progressPercent.Text = "100%"
                $stepTitle.Text = "Installation Complete!"
                $stepTitle.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF4ade80")
                $stepStatus.Text = "Tiger Cowork is up and running"

                $greenBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF4ade80")
                for ($i = 0; $i -lt $stepTextBlocks.Count; $i++) {
                    $entry = $stepTextBlocks[$i]
                    $entry.Icon.Text = [string][char]0x2713
                    $entry.Icon.Foreground = $greenBrush
                    $entry.Label.Foreground = $greenBrush
                    $entry.Label.FontWeight = "Normal"
                }
            }, [System.Windows.Threading.DispatcherPriority]::Background)
        }

        try {
            # ============================================================
            # STEP 1: Check / Install Docker
            # ============================================================
            Update-ProgressInner 1 7 "Checking Docker..." "Looking for Docker installation"
            Start-Sleep -Milliseconds 500

            $dockerExe = Find-DockerInner

            if (-not $dockerExe) {
                Update-ProgressInner 1 7 "Installing Docker Desktop..." "Downloading - this may take a few minutes"

                $dockerInstallerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
                $dockerInstallerPath = "$env:TEMP\DockerDesktopInstaller.exe"

                try {
                    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
                    $wc = New-Object System.Net.WebClient
                    $wc.DownloadFile($dockerInstallerUrl, $dockerInstallerPath)
                } catch {
                    Show-Error "Failed to download Docker Desktop. Please install it manually from https://docker.com/products/docker-desktop and run this installer again."
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }

                Update-ProgressInner 1 7 "Installing Docker Desktop..." "Running installer (admin prompt may appear)"

                try {
                    $proc = Start-Process -FilePath $dockerInstallerPath -ArgumentList "install", "--quiet", "--accept-license" -Wait -PassThru
                    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
                        Show-Error "Docker Desktop installer returned an error. Please install Docker manually and try again."
                        $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                        return
                    }
                } catch {
                    Show-Error "Failed to run Docker installer. Please install Docker Desktop manually from https://docker.com and try again."
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }

                Remove-Item $dockerInstallerPath -Force -ErrorAction SilentlyContinue

                # Refresh PATH after install
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                $dockerExe = Find-DockerInner
                if (-not $dockerExe) {
                    $dockerExe = "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe"
                }
            }

            # ============================================================
            # STEP 2: Start Docker Engine
            # ============================================================
            Update-ProgressInner 2 7 "Starting Docker Engine..." "Waiting for Docker daemon"

            $dockerRunning = $false
            try {
                $result = & $dockerExe info 2>&1
                if ($LASTEXITCODE -eq 0) { $dockerRunning = $true }
            } catch {}

            if (-not $dockerRunning) {
                # Try to start Docker Desktop
                $dockerDesktopExe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
                if (Test-Path $dockerDesktopExe) {
                    Start-Process -FilePath $dockerDesktopExe
                }

                $tries = 0
                while ($tries -lt 60) {
                    Start-Sleep -Seconds 3
                    $tries++
                    Update-ProgressInner 2 7 "Starting Docker Engine..." "Waiting for daemon... ($tries)"
                    try {
                        $null = & $dockerExe info 2>&1
                        if ($LASTEXITCODE -eq 0) { $dockerRunning = $true; break }
                    } catch {}
                }

                if (-not $dockerRunning) {
                    Show-Error "Docker Desktop did not start in time. Please open it manually and run this installer again."
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }
            }

            # ============================================================
            # STEP 3: Check / Install Git
            # ============================================================
            Update-ProgressInner 3 7 "Checking Git..." "Verifying git is available"
            Start-Sleep -Milliseconds 500

            $gitExe = Find-GitInner

            if (-not $gitExe) {
                Update-ProgressInner 3 7 "Installing Git..." "Trying winget first"

                $installed = $false

                # Try winget
                $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
                if ($wingetCmd) {
                    try {
                        $proc = Start-Process -FilePath "winget" -ArgumentList "install", "--id", "Git.Git", "-e", "--accept-package-agreements", "--accept-source-agreements" -Wait -PassThru -NoNewWindow
                        if ($proc.ExitCode -eq 0) { $installed = $true }
                    } catch {}
                }

                # If winget failed, try direct download
                if (-not $installed) {
                    Update-ProgressInner 3 7 "Installing Git..." "Downloading Git installer"

                    $gitInstallerUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
                    $gitInstallerPath = "$env:TEMP\GitInstaller.exe"

                    try {
                        $wc = New-Object System.Net.WebClient
                        $wc.DownloadFile($gitInstallerUrl, $gitInstallerPath)

                        Update-ProgressInner 3 7 "Installing Git..." "Running installer"
                        $proc = Start-Process -FilePath $gitInstallerPath -ArgumentList "/VERYSILENT", "/NORESTART" -Wait -PassThru
                        Remove-Item $gitInstallerPath -Force -ErrorAction SilentlyContinue
                    } catch {
                        Show-Error "Failed to install Git. Please install Git manually from https://git-scm.com and run this installer again."
                        $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                        return
                    }
                }

                # Refresh PATH
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                $gitExe = Find-GitInner

                if (-not $gitExe) {
                    # Last resort
                    $gitExe = "$env:ProgramFiles\Git\cmd\git.exe"
                    if (-not (Test-Path $gitExe)) {
                        Show-Error "Git installation completed but git.exe was not found. Please restart your computer and run this installer again."
                        $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                        return
                    }
                }
            }

            # ============================================================
            # STEP 4: Clone / Update repo
            # ============================================================
            Update-ProgressInner 4 7 "Downloading Tiger Cowork..." "Cloning repository"

            if (Test-Path (Join-Path $InstallDir ".git")) {
                Update-ProgressInner 4 7 "Updating Tiger Cowork..." "Pulling latest changes"
                Push-Location $InstallDir
                & $gitExe pull *>> $LOG_FILE
                Pop-Location
            } else {
                if (-not (Test-Path $InstallDir)) {
                    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
                }
                & $gitExe clone $REPO_URL $InstallDir *>> $LOG_FILE
                if ($LASTEXITCODE -ne 0) {
                    Show-Error "Failed to clone repository. Check your internet connection and try again.`nLog: $LOG_FILE"
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }
            }

            # ============================================================
            # STEP 5: Configure (.env)
            # ============================================================
            Update-ProgressInner 5 7 "Configuring..." "Setting up environment"
            Start-Sleep -Milliseconds 500

            $envFile = Join-Path $InstallDir ".env"
            if (-not (Test-Path $envFile)) {
                $envContent = @"
# Access token to protect the app (leave empty to disable auth)
ACCESS_TOKEN=
"@
                Set-Content -Path $envFile -Value $envContent -Encoding UTF8
            }

            # Check port conflict
            $portInUse = $false
            try {
                $listener = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue
                if ($listener) { $portInUse = $true }
            } catch {}

            if ($portInUse) {
                $progressWindow.Dispatcher.Invoke([Action]{
                    $result = [System.Windows.MessageBox]::Show(
                        "Port $PORT is already in use. Stop the process and continue?",
                        "Tiger Cowork",
                        "YesNo", "Warning")
                    if ($result -eq "No") {
                        $progressWindow.Close()
                    }
                })
            }

            # ============================================================
            # STEP 6: Build & Start Container
            # ============================================================
            Update-ProgressInner 6 7 "Building & Starting..." "This may take a few minutes on first run"

            Push-Location $InstallDir
            & $dockerExe compose up --build -d *>> $LOG_FILE
            $buildExit = $LASTEXITCODE
            Pop-Location

            if ($buildExit -ne 0) {
                Update-ProgressInner 6 7 "Build Failed" "Check log: $LOG_FILE"
                Show-Error "Failed to build and start Tiger Cowork.`nCheck log at: $LOG_FILE"
                $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                return
            }

            # Wait for server
            $tries = 0
            while ($tries -lt 60) {
                Start-Sleep -Seconds 1
                $tries++
                Update-ProgressInner 6 7 "Starting server..." "Waiting for app to be ready... ($tries`s)"
                try {
                    $response = Invoke-WebRequest -Uri $APP_URL -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
                    if ($response.StatusCode -eq 200) { break }
                } catch {}
            }

            # ============================================================
            # STEP 7: Done!
            # ============================================================
            Show-Completion
            Start-Sleep -Seconds 1

            # Copy start/stop scripts to install directory
            $scriptDir = Split-Path -Parent $PSCommandPath
            $startBat = Join-Path $scriptDir "TigerCoworkStart.bat"
            $stopBat  = Join-Path $scriptDir "TigerCoworkStop.bat"
            if ((Test-Path $startBat) -and ($scriptDir -ne $InstallDir)) {
                Copy-Item $startBat $InstallDir -Force -ErrorAction SilentlyContinue
            }
            if ((Test-Path $stopBat) -and ($scriptDir -ne $InstallDir)) {
                Copy-Item $stopBat $InstallDir -Force -ErrorAction SilentlyContinue
            }

            # Open browser
            Start-Process $APP_URL

        } catch {
            $errMsg = $_.Exception.Message
            Show-Error "Installation error: $errMsg`nCheck log at: $LOG_FILE"
            $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
        }

    }).AddArgument($progressWindow).AddArgument($progressFill).AddArgument($progressPercent).AddArgument(
        $stepTitle).AddArgument($stepStatus).AddArgument($stepTextBlocks).AddArgument(
        $barMaxWidth).AddArgument($InstallDir).AddArgument($REPO_URL).AddArgument(
        $APP_URL).AddArgument($PORT).AddArgument($LOG_FILE).AddArgument($stepLabels) | Out-Null

    $ps.BeginInvoke() | Out-Null
})

$progressWindow.ShowDialog() | Out-Null
