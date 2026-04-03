# TigrimOS - Windows Installer (PowerShell + WPF)
# Uses WSL2 Ubuntu as sandbox — matching macOS Virtualization.framework approach
# No Docker required

param(
    [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$REPO_URL   = "https://github.com/Sompote/TigrimOS.git"
$APP_URL    = "http://localhost:3001"
$PORT       = 3001
$WSL_DISTRO = "TigrimOS"
$LOG_FILE   = "$env:TEMP\tigrimos-install.log"

# Load WPF assemblies
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

# ============================================================
# STEP 0: Welcome + Folder Chooser
# ============================================================

$welcomeXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="TigrimOS Installer"
        Width="520" Height="480"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize"
        Background="#FF0f172a">
    <Window.Resources>
        <Style x:Key="AccentButton" TargetType="Button">
            <Setter Property="Background">
                <Setter.Value>
                    <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                        <GradientStop Color="#FF3b82f6" Offset="0"/>
                        <GradientStop Color="#FF6366f1" Offset="1"/>
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
    <Border Background="#FF0f172a">
        <Grid>
            <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center" Width="420">
                <!-- Logo -->
                <TextBlock Text="&#x1F42F;" FontSize="56" HorizontalAlignment="Center" Margin="0,0,0,8"/>
                <TextBlock Text="TigrimOS" FontSize="26" FontWeight="Bold" Foreground="White"
                           HorizontalAlignment="Center" Margin="0,0,0,2"/>
                <TextBlock Text="v1.0.0 — Windows Installer" FontSize="13" Foreground="#80FFFFFF"
                           HorizontalAlignment="Center" Margin="0,0,0,24"/>

                <!-- Description -->
                <TextBlock Foreground="#CCe2e8f0" FontSize="13" TextWrapping="Wrap" Margin="0,0,0,4">
                    A self-hosted AI workspace running inside a secure WSL2 Ubuntu sandbox.
                </TextBlock>
                <TextBlock Foreground="#CCe2e8f0" FontSize="13" TextWrapping="Wrap" Margin="0,0,0,12">
                    This installer will:
                </TextBlock>
                <TextBlock Foreground="#AAe2e8f0" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Enable WSL2 and install Ubuntu (if needed)"/>
                <TextBlock Foreground="#AAe2e8f0" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Install Git (if needed)"/>
                <TextBlock Foreground="#AAe2e8f0" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Download TigrimOS into the WSL2 sandbox"/>
                <TextBlock Foreground="#AAe2e8f0" FontSize="13" Margin="16,0,0,2" Text="&#x2022; Install Node.js 20 + Python 3 inside the sandbox"/>
                <TextBlock Foreground="#AAe2e8f0" FontSize="13" Margin="16,0,0,20" Text="&#x2022; Build and start TigrimOS"/>

                <!-- Shared folder (optional) -->
                <TextBlock Text="Shared folder (optional — VM can access this folder):" Foreground="#CCe2e8f0" FontSize="13" Margin="0,0,0,6"/>
                <Grid Margin="0,0,0,20">
                    <Grid.ColumnDefinitions>
                        <ColumnDefinition Width="*"/>
                        <ColumnDefinition Width="Auto"/>
                    </Grid.ColumnDefinitions>
                    <TextBox x:Name="PathBox" Grid.Column="0" Text=""
                             FontSize="13" Padding="8,6" Background="#1e293b" Foreground="White"
                             BorderBrush="#334155" BorderThickness="1"/>
                    <Button x:Name="BrowseBtn" Grid.Column="1" Content="Browse..."
                            Style="{StaticResource AccentButton}" Margin="8,0,0,0"
                            FontSize="12" Padding="12,6"/>
                </Grid>

                <!-- Action buttons -->
                <StackPanel Orientation="Horizontal" HorizontalAlignment="Center">
                    <Button x:Name="InstallBtn" Content="Install TigrimOS" Style="{StaticResource AccentButton}"
                            Padding="36,12" FontSize="16" Margin="0,0,12,0"/>
                    <Button x:Name="CancelBtn" Content="Cancel" Padding="24,12" FontSize="14"
                            Background="Transparent" Foreground="#80FFFFFF" BorderBrush="#334155"
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
$script:sharedFolder = ""

$browseBtn.Add_Click({
    $folderDialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $folderDialog.Description = "Choose a folder to share with TigrimOS (optional)"
    if ($folderDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $pathBox.Text = $folderDialog.SelectedPath
    }
})

$installBtn.Add_Click({
    $script:userCancelled = $false
    $script:sharedFolder = $pathBox.Text
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

$sharedFolder = $script:sharedFolder

# ============================================================
# Progress Window
# ============================================================

$stepLabels = @(
    "Enable WSL2",
    "Install Ubuntu Sandbox",
    "Download TigrimOS",
    "Install Node.js 20",
    "Install Python + Dependencies",
    "Build TigrimOS",
    "Start TigrimOS"
)

$progressXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Installing TigrimOS"
        Width="560" Height="540"
        WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize"
        Background="#FF0f172a">
    <Border CornerRadius="0">
        <Border.Background>
            <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                <GradientStop Color="#FF0f172a" Offset="0"/>
                <GradientStop Color="#FF1e293b" Offset="0.5"/>
                <GradientStop Color="#FF0f172a" Offset="1"/>
            </LinearGradientBrush>
        </Border.Background>
        <Grid>
            <StackPanel VerticalAlignment="Center" HorizontalAlignment="Center" Width="440">
                <!-- Logo -->
                <TextBlock Text="&#x1F42F;" FontSize="56" HorizontalAlignment="Center" Margin="0,0,0,8"/>
                <TextBlock Text="TigrimOS" FontSize="24" FontWeight="Bold" Foreground="White"
                           HorizontalAlignment="Center" Margin="0,0,0,4"/>
                <TextBlock Text="Installing..." FontSize="13" Foreground="#80FFFFFF"
                           HorizontalAlignment="Center" Margin="0,0,0,28"/>

                <!-- Progress bar -->
                <Border Background="#1e293b" CornerRadius="12" Height="24" Margin="0,0,0,16">
                    <Grid>
                        <Border x:Name="ProgressFill" CornerRadius="12" Height="24"
                                HorizontalAlignment="Left" Width="0">
                            <Border.Background>
                                <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                                    <GradientStop Color="#FF3b82f6" Offset="0"/>
                                    <GradientStop Color="#FF6366f1" Offset="1"/>
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
                           Foreground="#FF3b82f6" HorizontalAlignment="Center" Margin="0,0,0,4"/>
                <TextBlock x:Name="StepStatus" Text="" FontSize="13" Foreground="#94a3b8"
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
    $icon.Text = [char]0x25CB
    $icon.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#4b5563")
    $icon.VerticalAlignment = "Center"

    $label = New-Object System.Windows.Controls.TextBlock
    $label.Text = "Step $($i+1): $($stepLabels[$i])"
    $label.FontSize = 13
    $label.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#4b5563")
    $label.VerticalAlignment = "Center"

    $sp.Children.Add($icon) | Out-Null
    $sp.Children.Add($label) | Out-Null
    $stepsList.Children.Add($sp) | Out-Null

    $stepTextBlocks += @{ Icon = $icon; Label = $label; Panel = $sp }
}

# ============================================================
# Run installation in background runspace
# ============================================================

$barMaxWidth = 440

$progressWindow.Add_ContentRendered({
    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.ApartmentState = "STA"
    $runspace.Open()

    $ps = [powershell]::Create()
    $ps.Runspace = $runspace

    $ps.AddScript({
        param($progressWindow, $progressFill, $progressPercent, $stepTitle, $stepStatus,
              $stepTextBlocks, $barMaxWidth, $REPO_URL, $APP_URL, $PORT, $WSL_DISTRO, $LOG_FILE, $stepLabels, $sharedFolder)

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
                $blueBrush   = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF3b82f6")
                $dimBrush    = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#4b5563")

                for ($i = 0; $i -lt $stepTextBlocks.Count; $i++) {
                    $entry = $stepTextBlocks[$i]
                    if (($i + 1) -lt $CurrentStep) {
                        $entry.Icon.Text = [string][char]0x2713
                        $entry.Icon.Foreground = $greenBrush
                        $entry.Label.Foreground = $greenBrush
                        $entry.Label.FontWeight = "Normal"
                    } elseif (($i + 1) -eq $CurrentStep) {
                        $entry.Icon.Text = [string][char]0x27F3
                        $entry.Icon.Foreground = $blueBrush
                        $entry.Label.Foreground = $blueBrush
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

        function Show-Error {
            param([string]$msg)
            $progressWindow.Dispatcher.Invoke([Action]{
                [System.Windows.MessageBox]::Show($progressWindow, $msg, "TigrimOS", "OK", "Error") | Out-Null
            })
        }

        function Show-Completion {
            $progressWindow.Dispatcher.Invoke([Action]{
                $progressFill.Width = $barMaxWidth
                $progressPercent.Text = "100%"
                $stepTitle.Text = "Installation Complete!"
                $stepTitle.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF4ade80")
                $stepStatus.Text = "TigrimOS is running at http://localhost:$PORT"

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

        function Run-WSL {
            param([string]$Command)
            $result = wsl -d $WSL_DISTRO -- bash -c $Command 2>&1
            return $result
        }

        try {
            # ============================================================
            # STEP 1: Enable WSL2
            # ============================================================
            Update-ProgressInner 1 7 "Checking WSL2..." "Verifying Windows Subsystem for Linux"
            Start-Sleep -Milliseconds 500

            $wslInstalled = $false
            try {
                $wslStatus = wsl --status 2>&1
                if ($LASTEXITCODE -eq 0) { $wslInstalled = $true }
            } catch {}

            if (-not $wslInstalled) {
                Update-ProgressInner 1 7 "Enabling WSL2..." "This may require a restart"

                # Enable WSL feature
                try {
                    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList "-Command", "wsl --install --no-distribution" -Wait -PassThru -Verb RunAs
                    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
                        # Try the DISM approach
                        Start-Process -FilePath "powershell.exe" -ArgumentList "-Command", @"
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart;
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart
"@ -Wait -Verb RunAs
                    }
                } catch {
                    Show-Error "Failed to enable WSL2. Please run 'wsl --install' manually in an admin PowerShell, restart your PC, then run this installer again."
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }

                # Check if reboot needed
                try {
                    $null = wsl --status 2>&1
                    if ($LASTEXITCODE -ne 0) {
                        Show-Error "WSL2 has been enabled but a restart is required.`n`nPlease restart your computer, then run this installer again."
                        $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                        return
                    }
                } catch {
                    Show-Error "WSL2 has been enabled but a restart is required.`n`nPlease restart your computer, then run this installer again."
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }
            }

            # Ensure WSL2 is default
            wsl --set-default-version 2 *>> $LOG_FILE

            # ============================================================
            # STEP 2: Install Ubuntu Sandbox
            # ============================================================
            Update-ProgressInner 2 7 "Setting up Ubuntu Sandbox..." "Checking for TigrimOS WSL distribution"
            Start-Sleep -Milliseconds 500

            $distroExists = $false
            try {
                $null = wsl -d $WSL_DISTRO -- echo ok 2>&1
                if ($LASTEXITCODE -eq 0) { $distroExists = $true }
            } catch {}

            if (-not $distroExists) {
                Update-ProgressInner 2 7 "Installing Ubuntu 22.04..." "Downloading — this may take a few minutes"

                # Install Ubuntu 22.04 as a custom named distro
                # First install Ubuntu, then export/import with our name
                $ubuntuInstalled = $false
                try {
                    $null = wsl -d Ubuntu-22.04 -- echo ok 2>&1
                    if ($LASTEXITCODE -eq 0) { $ubuntuInstalled = $true }
                } catch {}

                if (-not $ubuntuInstalled) {
                    Update-ProgressInner 2 7 "Downloading Ubuntu 22.04..." "This may take 5-10 minutes"
                    wsl --install -d Ubuntu-22.04 --no-launch *>> $LOG_FILE

                    # Initialize with default user
                    $initScript = "useradd -m -s /bin/bash tigrimos && echo 'tigrimos:tigrimos' | chpasswd && usermod -aG sudo tigrimos && echo 'tigrimos ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers"
                    wsl -d Ubuntu-22.04 -- bash -c $initScript *>> $LOG_FILE
                }

                Update-ProgressInner 2 7 "Creating TigrimOS sandbox..." "Exporting and importing WSL distribution"

                # Export Ubuntu and re-import as TigrimOS
                $exportPath = "$env:TEMP\tigrimos-ubuntu.tar"
                wsl --export Ubuntu-22.04 $exportPath *>> $LOG_FILE

                # Import as TigrimOS distro
                $wslStorePath = "$env:LOCALAPPDATA\TigrimOS\WSL"
                if (-not (Test-Path $wslStorePath)) {
                    New-Item -ItemType Directory -Path $wslStorePath -Force | Out-Null
                }
                wsl --import $WSL_DISTRO $wslStorePath $exportPath *>> $LOG_FILE

                # Clean up export
                Remove-Item $exportPath -Force -ErrorAction SilentlyContinue

                if ($LASTEXITCODE -ne 0) {
                    Show-Error "Failed to create TigrimOS WSL distribution. Check log: $LOG_FILE"
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }

                # Set default user
                wsl -d $WSL_DISTRO -- bash -c "echo '[user]' > /etc/wsl.conf && echo 'default=tigrimos' >> /etc/wsl.conf" *>> $LOG_FILE
            }

            # ============================================================
            # STEP 3: Download TigrimOS
            # ============================================================
            Update-ProgressInner 3 7 "Downloading TigrimOS..." "Cloning repository into sandbox"

            $repoExists = wsl -d $WSL_DISTRO -- bash -c "test -d /opt/TigrimOS/.git && echo yes || echo no" 2>&1
            if ($repoExists -match "yes") {
                Update-ProgressInner 3 7 "Updating TigrimOS..." "Pulling latest changes"
                wsl -d $WSL_DISTRO -- bash -c "cd /opt/TigrimOS && git pull" *>> $LOG_FILE
            } else {
                # Install git inside WSL if needed
                wsl -d $WSL_DISTRO -- bash -c "which git >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq git)" *>> $LOG_FILE

                wsl -d $WSL_DISTRO -- bash -c "rm -rf /opt/TigrimOS && git clone $REPO_URL /opt/TigrimOS" *>> $LOG_FILE
                if ($LASTEXITCODE -ne 0) {
                    Show-Error "Failed to clone TigrimOS. Check your internet connection.`nLog: $LOG_FILE"
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }
            }

            # Set ownership
            wsl -d $WSL_DISTRO -- bash -c "chown -R tigrimos:tigrimos /opt/TigrimOS" *>> $LOG_FILE

            # ============================================================
            # STEP 4: Install Node.js 20
            # ============================================================
            Update-ProgressInner 4 7 "Installing Node.js 20..." "Setting up Node.js inside sandbox"

            $nodeInstalled = wsl -d $WSL_DISTRO -- bash -c "node --version 2>/dev/null | grep -q 'v20' && echo yes || echo no" 2>&1
            if ($nodeInstalled -match "yes") {
                Update-ProgressInner 4 7 "Node.js 20" "Already installed"
                Start-Sleep -Milliseconds 500
            } else {
                wsl -d $WSL_DISTRO -- bash -c @"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs
npm install -g npm@latest
"@ *>> $LOG_FILE

                if ($LASTEXITCODE -ne 0) {
                    Show-Error "Failed to install Node.js. Check log: $LOG_FILE"
                    $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                    return
                }
            }

            # ============================================================
            # STEP 5: Install Python + Dependencies
            # ============================================================
            Update-ProgressInner 5 7 "Installing Python..." "Setting up Python 3 + packages"

            wsl -d $WSL_DISTRO -- bash -c @"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq python3 python3-pip python3-venv
pip3 install numpy pandas matplotlib scipy 2>/dev/null || true
"@ *>> $LOG_FILE

            # ============================================================
            # STEP 6: Build TigrimOS
            # ============================================================
            Update-ProgressInner 6 7 "Building TigrimOS..." "Installing dependencies and building"

            wsl -d $WSL_DISTRO -- bash -c @"
cd /opt/TigrimOS/tiger_cowork
npm install 2>&1
cd client && npm install 2>&1 && npm run build 2>&1
"@ *>> $LOG_FILE

            if ($LASTEXITCODE -ne 0) {
                Show-Error "Failed to build TigrimOS. Check log: $LOG_FILE"
                $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
                return
            }

            # Configure shared folder if provided
            if ($sharedFolder -and (Test-Path $sharedFolder)) {
                $wslPath = $sharedFolder -replace '\\', '/' -replace '^([A-Za-z]):', '/mnt/$1'
                $wslPath = $wslPath.Substring(0,5).ToLower() + $wslPath.Substring(5)
                wsl -d $WSL_DISTRO -- bash -c "mkdir -p /mnt/shared && ln -sf '$wslPath' /mnt/shared/host" *>> $LOG_FILE
            }

            # Create .env
            wsl -d $WSL_DISTRO -- bash -c @"
cat > /opt/TigrimOS/tiger_cowork/.env << 'ENVEOF'
PORT=3001
NODE_ENV=production
SANDBOX_DIR=/opt/TigrimOS/tiger_cowork
ACCESS_TOKEN=
ENVEOF
"@ *>> $LOG_FILE

            # ============================================================
            # STEP 7: Start TigrimOS
            # ============================================================
            Update-ProgressInner 7 7 "Starting TigrimOS..." "Launching server"

            # Kill any existing
            wsl -d $WSL_DISTRO -- bash -c "pkill -f 'node.*server' 2>/dev/null; pkill -f 'tsx.*index' 2>/dev/null; true"
            Start-Sleep -Seconds 1

            # Start server
            wsl -d $WSL_DISTRO -- bash -c "cd /opt/TigrimOS/tiger_cowork && export NODE_ENV=production && export PORT=3001 && nohup npx tsx server/index.ts > /tmp/tigrimos.log 2>&1 &"

            # Wait for server
            $tries = 0
            $serverReady = $false
            while ($tries -lt 60) {
                Start-Sleep -Seconds 2
                $tries++
                Update-ProgressInner 7 7 "Starting TigrimOS..." "Waiting for server to be ready... ($tries)"
                try {
                    $response = Invoke-WebRequest -Uri $APP_URL -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
                    if ($response.StatusCode -eq 200) { $serverReady = $true; break }
                } catch {}
            }

            if (-not $serverReady) {
                Update-ProgressInner 7 7 "Warning" "Server may still be starting — opening browser anyway"
                Start-Sleep -Seconds 2
            }

            # ============================================================
            # Done!
            # ============================================================
            Show-Completion

            # Create desktop shortcut
            try {
                $desktopPath = [Environment]::GetFolderPath("Desktop")
                $shortcutPath = Join-Path $desktopPath "TigrimOS.lnk"
                $scriptRoot = Split-Path -Parent $PSCommandPath
                $startBat = Join-Path $scriptRoot "TigrimOSStart.bat"

                if (Test-Path $startBat) {
                    $shell = New-Object -ComObject WScript.Shell
                    $shortcut = $shell.CreateShortcut($shortcutPath)
                    $shortcut.TargetPath = $startBat
                    $shortcut.WorkingDirectory = $scriptRoot
                    $shortcut.Description = "TigrimOS — AI Workspace"
                    $shortcut.Save()
                }
            } catch {
                # Non-critical — skip silently
            }

            Start-Sleep -Seconds 1

            # Open browser
            Start-Process $APP_URL

        } catch {
            $errMsg = $_.Exception.Message
            Show-Error "Installation error: $errMsg`nCheck log at: $LOG_FILE"
            $progressWindow.Dispatcher.Invoke([Action]{ $progressWindow.Close() })
        }

    }).AddArgument($progressWindow).AddArgument($progressFill).AddArgument($progressPercent).AddArgument(
        $stepTitle).AddArgument($stepStatus).AddArgument($stepTextBlocks).AddArgument(
        $barMaxWidth).AddArgument($REPO_URL).AddArgument(
        $APP_URL).AddArgument($PORT).AddArgument($WSL_DISTRO).AddArgument($LOG_FILE).AddArgument($stepLabels).AddArgument($sharedFolder) | Out-Null

    $ps.BeginInvoke() | Out-Null
})

$progressWindow.ShowDialog() | Out-Null
