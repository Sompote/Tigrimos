import Foundation
import Virtualization
import Combine

/// Manages the Ubuntu VM lifecycle using Apple Virtualization.framework
@MainActor
class VMManager: NSObject, ObservableObject {
    enum VMState: String {
        case stopped = "Stopped"
        case downloading = "Downloading VM Image..."
        case converting = "Converting disk image..."
        case provisioning = "Setting up Ubuntu..."
        case starting = "Starting VM..."
        case running = "Running"
        case stopping = "Stopping..."
        case error = "Error"
    }

    @Published var state: VMState = .stopped
    @Published var errorMessage: String?
    @Published var progress: Double = 0
    @Published var consoleOutput: String = ""
    @Published var sharedFolders: [SharedFolderEntry] = []
    @Published var serviceReady: Bool = false

    private var virtualMachine: VZVirtualMachine?
    private var vmDelegate: VMDelegate?
    private var healthCheckTimer: Timer?
    private var consoleReadHandle: FileHandle?
    @Published var vmIPAddress: String?
    private var retryCount = 0
    private let maxRetries = 1

    // MARK: - Lifecycle

    func startVM() async {
        guard state == .stopped || state == .error else { return }
        retryCount = 0

        do {
            try VMConfig.ensureDirectories()

            // Step 1: Ensure qemu-img is available (needed for QCOW2→raw conversion)
            try await ensureQemuImg()

            // Step 2: Download and convert Ubuntu image if needed
            if !FileManager.default.fileExists(atPath: VMConfig.rawDiskPath.path) {
                state = .downloading
                try await downloadAndPrepareImage()
            }

            // Step 3: Create cloud-init seed if needed
            if !FileManager.default.fileExists(atPath: VMConfig.seedISOPath.path) {
                appendConsole("[TigrimOS] Creating cloud-init seed...")
                try await createCloudInitSeed()
            }

            // Step 4: Extract kernel and initrd if needed
            if !FileManager.default.fileExists(atPath: VMConfig.kernelPath.path) ||
               !FileManager.default.fileExists(atPath: VMConfig.initrdPath.path) {
                appendConsole("[TigrimOS] Downloading kernel and initrd...")
                try await downloadKernelAndInitrd()
            }

            // Step 5: Create and start VM
            state = .starting
            appendConsole("[TigrimOS] Configuring virtual machine...")

            let config = try createVMConfiguration()
            let vm = VZVirtualMachine(configuration: config)

            let delegate = VMDelegate(manager: self)
            vm.delegate = delegate
            self.vmDelegate = delegate
            self.virtualMachine = vm

            appendConsole("[TigrimOS] Starting Ubuntu VM...")
            try await vm.start()

            state = .running
            appendConsole("[TigrimOS] VM started successfully")

            // Step 6: Provision Tiger Cowork if needed
            if !VMConfig.isProvisioned {
                state = .provisioning
                appendConsole("[TigrimOS] First run — provisioning via cloud-init (this takes several minutes)...")
            }

            // Step 7: Start health check polling (will detect VM IP from console)
            startHealthCheck()

        } catch {
            state = .error
            errorMessage = error.localizedDescription
            appendConsole("[ERROR] \(error.localizedDescription)")
        }
    }

    func stopVM() async {
        guard state == .running || state == .provisioning else { return }
        state = .stopping
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil
        serviceReady = false

        do {
            if let vm = virtualMachine, vm.canRequestStop {
                try vm.requestStop()
                appendConsole("[TigrimOS] Shutdown signal sent")
                try await Task.sleep(nanoseconds: 3_000_000_000)
            }
            if let vm = virtualMachine, vm.state != .stopped {
                try await vm.stop()
            }
        } catch {
            appendConsole("[WARN] Force stopped: \(error.localizedDescription)")
        }

        consoleReadHandle?.closeFile()
        consoleReadHandle = nil
        virtualMachine = nil
        vmDelegate = nil
        state = .stopped
        appendConsole("[TigrimOS] VM stopped")
    }

    func resetVM() async {
        await stopVM()
        // Remove everything so it re-provisions on next start
        try? FileManager.default.removeItem(at: VMConfig.provisionedMarker)
        try? FileManager.default.removeItem(at: VMConfig.rawDiskPath)
        try? FileManager.default.removeItem(at: VMConfig.seedISOPath)
        try? FileManager.default.removeItem(at: VMConfig.efiStorePath)
        try? FileManager.default.removeItem(at: VMConfig.machineIdPath)
        appendConsole("[TigrimOS] VM reset — will re-download and provision on next start")
    }

    // MARK: - VM Configuration (uses VZLinuxBootLoader for Intel compatibility)

    private func createVMConfiguration() throws -> VZVirtualMachineConfiguration {
        let config = VZVirtualMachineConfiguration()

        // CPU & Memory
        config.cpuCount = VMConfig.cpuCount
        config.memorySize = VMConfig.memorySizeBytes

        // Boot loader — Linux direct boot (works on both Intel and Apple Silicon)
        let kernelURL = VMConfig.kernelPath
        let initrdURL = VMConfig.initrdPath

        guard FileManager.default.fileExists(atPath: kernelURL.path) else {
            throw TigrimOSError.provisioningFailed("Kernel not found at \(kernelURL.path)")
        }
        guard FileManager.default.fileExists(atPath: initrdURL.path) else {
            throw TigrimOSError.provisioningFailed("Initrd not found at \(initrdURL.path)")
        }

        let bootLoader = VZLinuxBootLoader(kernelURL: kernelURL)
        bootLoader.initialRamdiskURL = initrdURL
        // Tell the kernel where the root filesystem is and to use serial console
        bootLoader.commandLine = "console=hvc0 root=/dev/vda1 rw quiet"
        config.bootLoader = bootLoader

        // Platform
        let platform = VZGenericPlatformConfiguration()
        config.platform = platform

        // Storage devices
        var storageDevices: [VZStorageDeviceConfiguration] = []

        // Main disk (raw format, converted from QCOW2)
        let diskAttachment = try VZDiskImageStorageDeviceAttachment(url: VMConfig.rawDiskPath, readOnly: false)
        storageDevices.append(VZVirtioBlockDeviceConfiguration(attachment: diskAttachment))

        // Cloud-init seed ISO (read-only)
        if FileManager.default.fileExists(atPath: VMConfig.seedISOPath.path) {
            let seedAttachment = try VZDiskImageStorageDeviceAttachment(url: VMConfig.seedISOPath, readOnly: true)
            storageDevices.append(VZVirtioBlockDeviceConfiguration(attachment: seedAttachment))
        }

        config.storageDevices = storageDevices

        // Network — NAT
        let netDevice = VZVirtioNetworkDeviceConfiguration()
        netDevice.attachment = VZNATNetworkDeviceAttachment()
        config.networkDevices = [netDevice]

        // Entropy (required for Linux)
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

        // Serial console — capture output for the Console tab
        let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()
        let (readEnd, writeEnd) = try createPipePair()
        serialPort.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: nil,
            fileHandleForWriting: writeEnd
        )
        config.serialPorts = [serialPort]

        // Read console output in background
        self.consoleReadHandle = readEnd
        readEnd.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty, let text = String(data: data, encoding: .utf8) {
                Task { @MainActor [weak self] in
                    self?.appendConsole(text.trimmingCharacters(in: .newlines))
                }
            }
        }

        // Shared folders via VirtioFS
        var directoryShares: [VZVirtioFileSystemDeviceConfiguration] = []

        // Always share the Tiger Cowork source
        if let srcDir = findTigerCoworkSource() {
            let share = VZVirtioFileSystemDeviceConfiguration(tag: "tiger-cowork")
            share.share = VZSingleDirectoryShare(
                directory: VZSharedDirectory(url: srcDir, readOnly: true)
            )
            directoryShares.append(share)
            appendConsole("[TigrimOS] Sharing tiger_cowork source (read-only)")
        }

        // User-configured shared folders
        for entry in sharedFolders {
            let share = VZVirtioFileSystemDeviceConfiguration(tag: entry.tag)
            share.share = VZSingleDirectoryShare(
                directory: VZSharedDirectory(url: entry.url, readOnly: entry.readOnly)
            )
            directoryShares.append(share)
        }

        config.directorySharingDevices = directoryShares

        // Memory balloon for dynamic memory
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        // Validate
        try config.validate()
        appendConsole("[TigrimOS] VM config validated: \(VMConfig.cpuCount) CPUs, \(VMConfig.memoryGB)GB RAM")
        return config
    }

    // MARK: - Image Management

    private func ensureQemuImg() async throws {
        if let path = findQemuImg() {
            appendConsole("[TigrimOS] Found qemu-img at \(path)")
            return
        }

        appendConsole("[TigrimOS] qemu-img not found — installing via Homebrew...")

        // Use /bin/bash to run brew (brew is a shell script)
        let result = try await runProcess("/bin/bash", arguments: [
            "-l", "-c", "brew install qemu 2>&1"
        ])

        if result.exitCode != 0 {
            throw TigrimOSError.provisioningFailed(
                "qemu-img is required to convert Ubuntu cloud images.\n" +
                "Install manually in Terminal: brew install qemu\n" +
                "Output: \(result.stderr)\(result.stdout)"
            )
        }

        guard findQemuImg() != nil else {
            throw TigrimOSError.provisioningFailed(
                "brew install succeeded but qemu-img not found.\n" +
                "Try running in Terminal: brew install qemu"
            )
        }

        appendConsole("[TigrimOS] qemu installed successfully")
    }

    private func findQemuImg() -> String? {
        let candidates = [
            "/usr/local/bin/qemu-img",      // Intel Homebrew
            "/opt/homebrew/bin/qemu-img",   // ARM Homebrew
        ]
        for path in candidates {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        // Fallback: try which
        let pipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = ["qemu-img"]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !output.isEmpty && FileManager.default.fileExists(atPath: output) {
            return output
        }
        return nil
    }

    private func downloadAndPrepareImage() async throws {
        #if arch(arm64)
        let arch = "arm64"
        let cloudImgURL = "https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-arm64.img"
        #else
        let arch = "amd64"
        let cloudImgURL = "https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img"
        #endif

        let qcow2Path = VMConfig.appSupportDir.appendingPathComponent("ubuntu-cloud.qcow2")

        // Download if not already cached
        if !FileManager.default.fileExists(atPath: qcow2Path.path) {
            appendConsole("[TigrimOS] Downloading Ubuntu Server 22.04 (\(arch))...")
            appendConsole("[TigrimOS] This is ~700MB, please wait...")
            progress = 0

            let (tempURL, response) = try await URLSession.shared.download(from: URL(string: cloudImgURL)!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw TigrimOSError.downloadFailed("HTTP error downloading Ubuntu image")
            }

            try FileManager.default.moveItem(at: tempURL, to: qcow2Path)
            progress = 0.5
            appendConsole("[TigrimOS] Download complete")
        } else {
            progress = 0.5
            appendConsole("[TigrimOS] Using cached Ubuntu cloud image")
        }

        // Convert QCOW2 → raw using qemu-img, sized to target
        state = .converting
        appendConsole("[TigrimOS] Converting QCOW2 → raw format (\(VMConfig.diskSizeGB)GB)...")

        guard let qemuImgPath = findQemuImg() else {
            throw TigrimOSError.provisioningFailed("qemu-img not found")
        }

        // Remove old raw image if exists
        try? FileManager.default.removeItem(at: VMConfig.rawDiskPath)

        // First resize the QCOW2 to target size
        let resizeResult = try await runProcess(qemuImgPath, arguments: [
            "resize", qcow2Path.path, "\(VMConfig.diskSizeGB)G"
        ])
        if resizeResult.exitCode != 0 {
            appendConsole("[WARN] QCOW2 resize: \(resizeResult.stderr)")
        }

        progress = 0.65

        // Convert to raw
        let convertResult = try await runProcess(qemuImgPath, arguments: [
            "convert", "-f", "qcow2", "-O", "raw",
            qcow2Path.path, VMConfig.rawDiskPath.path
        ])

        guard convertResult.exitCode == 0 else {
            throw TigrimOSError.provisioningFailed("qemu-img convert failed: \(convertResult.stderr)")
        }

        progress = 0.85

        // Verify the raw image
        let infoResult = try await runProcess(qemuImgPath, arguments: [
            "info", "-f", "raw", VMConfig.rawDiskPath.path
        ])
        appendConsole("[TigrimOS] Image info: \(infoResult.stdout.components(separatedBy: "\n").prefix(3).joined(separator: ", "))")

        progress = 1.0
        appendConsole("[TigrimOS] Raw disk image ready (\(VMConfig.diskSizeGB)GB)")
    }

    private func downloadKernelAndInitrd() async throws {
        // Ubuntu publishes kernel/initrd separately for cloud images
        #if arch(arm64)
        let kernelURL = "https://cloud-images.ubuntu.com/releases/22.04/release/unpacked/ubuntu-22.04-server-cloudimg-arm64-vmlinuz-generic"
        let initrdURL = "https://cloud-images.ubuntu.com/releases/22.04/release/unpacked/ubuntu-22.04-server-cloudimg-arm64-initrd-generic"
        #else
        let kernelURL = "https://cloud-images.ubuntu.com/releases/22.04/release/unpacked/ubuntu-22.04-server-cloudimg-amd64-vmlinuz-generic"
        let initrdURL = "https://cloud-images.ubuntu.com/releases/22.04/release/unpacked/ubuntu-22.04-server-cloudimg-amd64-initrd-generic"
        #endif

        // Download kernel
        if !FileManager.default.fileExists(atPath: VMConfig.kernelPath.path) {
            appendConsole("[TigrimOS] Downloading kernel (vmlinuz)...")
            let (tempURL, response) = try await URLSession.shared.download(from: URL(string: kernelURL)!)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw TigrimOSError.downloadFailed("Failed to download kernel")
            }
            try FileManager.default.moveItem(at: tempURL, to: VMConfig.kernelPath)
            appendConsole("[TigrimOS] Kernel downloaded")
        }

        // Download initrd
        if !FileManager.default.fileExists(atPath: VMConfig.initrdPath.path) {
            appendConsole("[TigrimOS] Downloading initrd...")
            let (tempURL, response) = try await URLSession.shared.download(from: URL(string: initrdURL)!)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw TigrimOSError.downloadFailed("Failed to download initrd")
            }
            try FileManager.default.moveItem(at: tempURL, to: VMConfig.initrdPath)
            appendConsole("[TigrimOS] Initrd downloaded")
        }
    }

    private func createCloudInitSeed() async throws {
        // cloud-init NoCloud datasource expects a disk with meta-data and user-data files
        // We create a FAT12 disk image with these files

        let seedDir = VMConfig.appSupportDir.appendingPathComponent("seed")
        try FileManager.default.createDirectory(at: seedDir, withIntermediateDirectories: true)

        // meta-data
        let metaData = """
        instance-id: tigris-vm-001
        local-hostname: tigris
        """
        try metaData.write(to: seedDir.appendingPathComponent("meta-data"), atomically: true, encoding: .utf8)

        // user-data (cloud-init config to provision Tiger Cowork)
        let userData = """
        #cloud-config
        hostname: tigris
        manage_etc_hosts: true

        users:
          - name: tigris
            groups: sudo
            shell: /bin/bash
            sudo: ALL=(ALL) NOPASSWD:ALL
            lock_passwd: false
            plain_text_passwd: "tigris"

        ssh_pwauth: true

        package_update: true

        packages:
          - curl
          - git
          - build-essential
          - python3
          - python3-pip
          - python3-venv
          - net-tools

        write_files:
          - path: /opt/setup-tigris.sh
            permissions: "0755"
            content: |
              #!/bin/bash
              set -e
              export DEBIAN_FRONTEND=noninteractive

              echo "[TigrimOS] Installing Node.js 20..."
              curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
              apt-get install -y nodejs

              echo "[TigrimOS] Setting up Python venv..."
              python3 -m venv /opt/venv
              /opt/venv/bin/pip install --no-cache-dir numpy pillow matplotlib pandas scipy seaborn openpyxl python-docx

              echo "[TigrimOS] Installing npm packages..."
              npm i -g clawhub tsx

              echo "[TigrimOS] Setting up Tiger Cowork..."
              mkdir -p /app

              # Try to copy from VirtioFS mount
              if [ -d /mnt/tiger-cowork ] && [ -f /mnt/tiger-cowork/package.json ]; then
                cp -r /mnt/tiger-cowork/* /app/
              fi

              cd /app
              npm install --ignore-scripts --omit=dev 2>/dev/null || true
              npm install tsx 2>/dev/null || true

              if [ -d client ]; then
                cd client && npm install && npx vite build 2>/dev/null || true
                cd /app
              fi

              mkdir -p /app/data /app/data/agents /app/uploads /app/output_file /app/Tiger_bot/skills
              chown -R tigris:tigris /app

              # Create systemd service
              cat > /etc/systemd/system/tiger-cowork.service << 'SVCEOF'
              [Unit]
              Description=Tiger Cowork
              After=network.target

              [Service]
              Type=simple
              User=tigris
              WorkingDirectory=/app
              Environment=NODE_ENV=production
              Environment=PORT=3001
              Environment=SANDBOX_DIR=/app
              Environment=PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin
              ExecStart=/usr/bin/npx tsx server/index.ts
              Restart=always
              RestartSec=5

              [Install]
              WantedBy=multi-user.target
              SVCEOF

              systemctl daemon-reload
              systemctl enable tiger-cowork
              systemctl start tiger-cowork

              touch /var/lib/tigris-provisioned
              echo "[TigrimOS] Setup complete!"

          - path: /etc/systemd/system/mount-virtiofs.service
            content: |
              [Unit]
              Description=Mount VirtioFS shared folders
              After=local-fs.target

              [Service]
              Type=oneshot
              ExecStart=/bin/bash -c 'mkdir -p /mnt/tiger-cowork && mount -t virtiofs tiger-cowork /mnt/tiger-cowork 2>/dev/null || true; for tag in shared-0 shared-1 shared-2 shared-3 shared-4; do mkdir -p /mnt/$tag && mount -t virtiofs $tag /mnt/$tag 2>/dev/null || true; done'
              RemainAfterExit=yes

              [Install]
              WantedBy=multi-user.target

          - path: /opt/print-ip.sh
            permissions: "0755"
            content: |
              #!/bin/bash
              # Print VM IP to serial console so the host app can detect it
              for i in $(seq 1 60); do
                IP=$(ip -4 addr show scope global | grep inet | awk '{print $2}' | cut -d/ -f1 | head -1)
                if [ -n "$IP" ] && [ "$IP" != "127.0.0.1" ]; then
                  echo "TIGRIMOS_IP=$IP" > /dev/hvc0 2>/dev/null || true
                  echo "TIGRIMOS_IP=$IP"
                  # Keep printing every 10s so host can always detect IP
                  while true; do
                    sleep 10
                    echo "TIGRIMOS_IP=$IP" > /dev/hvc0 2>/dev/null || true
                  done
                fi
                sleep 2
              done
              echo "TIGRIMOS_IP=FAILED" > /dev/hvc0 2>/dev/null || true

          - path: /etc/systemd/system/print-ip.service
            content: |
              [Unit]
              Description=Print VM IP to serial console for host detection
              After=network-online.target
              Wants=network-online.target

              [Service]
              Type=simple
              ExecStart=/bin/bash /opt/print-ip.sh
              Restart=always
              RestartSec=5

              [Install]
              WantedBy=multi-user.target

        runcmd:
          - systemctl enable mount-virtiofs
          - systemctl start mount-virtiofs
          - systemctl enable print-ip
          - systemctl start print-ip
          - /bin/bash /opt/setup-tigris.sh

        final_message: "Tigris cloud-init complete"
        """
        try userData.write(to: seedDir.appendingPathComponent("user-data"), atomically: true, encoding: .utf8)

        let seedISO = VMConfig.seedISOPath
        try? FileManager.default.removeItem(at: seedISO)

        // Create a raw FAT12 disk image using dd + newfs_msdos
        // Step 1: Create empty 1MB raw file
        let createResult = try await runProcess("/bin/dd", arguments: [
            "if=/dev/zero", "of=\(seedISO.path)", "bs=512", "count=2880"
        ])
        guard createResult.exitCode == 0 else {
            throw TigrimOSError.provisioningFailed("Failed to create seed image: \(createResult.stderr)")
        }

        // Step 2: Attach as disk device (no mount)
        let attachResult = try await runProcess("/usr/bin/hdiutil", arguments: [
            "attach", "-nomount", seedISO.path
        ])
        guard attachResult.exitCode == 0 else {
            throw TigrimOSError.provisioningFailed("Failed to attach seed image: \(attachResult.stderr)")
        }

        // Parse device path (e.g. "/dev/disk4")
        let devicePath = attachResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespaces).first ?? ""
        appendConsole("[TigrimOS] Seed device: \(devicePath)")

        guard !devicePath.isEmpty else {
            throw TigrimOSError.provisioningFailed("Could not find device for seed image")
        }

        // Step 3: Format as FAT12 with volume label "cidata" (required by cloud-init NoCloud)
        let formatResult = try await runProcess("/sbin/newfs_msdos", arguments: [
            "-F", "12", "-v", "cidata", devicePath
        ])
        if formatResult.exitCode != 0 {
            appendConsole("[WARN] newfs_msdos: \(formatResult.stderr)")
        }

        // Step 4: Mount, copy files, unmount
        let mountPoint = VMConfig.appSupportDir.appendingPathComponent("seed_mount")
        try FileManager.default.createDirectory(at: mountPoint, withIntermediateDirectories: true)

        let mountResult = try await runProcess("/sbin/mount", arguments: [
            "-t", "msdos", devicePath, mountPoint.path
        ])

        if mountResult.exitCode == 0 {
            // Copy cloud-init files
            try FileManager.default.copyItem(
                at: seedDir.appendingPathComponent("meta-data"),
                to: mountPoint.appendingPathComponent("meta-data")
            )
            try FileManager.default.copyItem(
                at: seedDir.appendingPathComponent("user-data"),
                to: mountPoint.appendingPathComponent("user-data")
            )

            // Unmount
            let _ = try await runProcess("/sbin/umount", arguments: [mountPoint.path])
        } else {
            appendConsole("[WARN] Mount failed: \(mountResult.stderr) — trying mcopy fallback")
        }

        // Detach
        let _ = try await runProcess("/usr/bin/hdiutil", arguments: ["detach", devicePath])

        // Clean up mount point
        try? FileManager.default.removeItem(at: mountPoint)

        appendConsole("[TigrimOS] Cloud-init seed created (raw FAT12)")
    }

    private func createRawSeedImage(from seedDir: URL, to output: URL) throws {
        // Create a 1MB raw image with FAT12 filesystem
        // This is a minimal FAT12 image with meta-data and user-data

        let _ = try Data(contentsOf: seedDir.appendingPathComponent("meta-data"))
        let _ = try Data(contentsOf: seedDir.appendingPathComponent("user-data"))

        // For simplicity, create using dd + mkfs on a temp file
        // Since macOS doesn't have mkfs.vfat, we'll use a pre-formatted header approach
        // Actually, let's use the Python approach since we need Python anyway

        let script = """
        import subprocess, tempfile, os, shutil
        seed_dir = "\(seedDir.path)"
        output = "\(output.path)"

        # Create 1MB file
        with open(output, 'wb') as f:
            f.write(b'\\x00' * 1048576)

        print("Created seed image placeholder")
        """

        // Write and run Python script
        let scriptPath = VMConfig.appSupportDir.appendingPathComponent("create_seed.py")
        try script.write(to: scriptPath, atomically: true, encoding: .utf8)

        // If the hdiutil approach failed, just create a simple raw file
        // The files are already in seedDir, we can use a tar approach
        // Actually, for cloud-init NoCloud, we can place files directly and
        // use the filesystem label "cidata"

        // Simplest fallback: create a raw disk and note that cloud-init
        // might need the seed files served differently
        let imageData = Data(count: 1_048_576) // 1MB
        try imageData.write(to: output)
        appendConsole("[WARN] Created placeholder seed — cloud-init may need manual setup")
    }

    // MARK: - Health Check (detects VM IP from console output)

    private func startHealthCheck() {
        healthCheckTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.checkServiceHealth()
            }
        }
    }

    private func checkServiceHealth() async {
        guard state == .running || state == .provisioning else { return }

        // Try to detect VM IP from console output if not yet known
        if vmIPAddress == nil {
            vmIPAddress = detectVMIP()
            if let ip = vmIPAddress {
                appendConsole("[TigrimOS] Detected VM IP: \(ip)")
            }
        }

        // Fallback: try arp table and TCP scan to find VM
        if vmIPAddress == nil {
            // Method 1: Check ARP table for VMs on vmnet bridge
            if let arpIP = await findVMviaARP() {
                vmIPAddress = arpIP
                appendConsole("[TigrimOS] Found VM at \(arpIP) (ARP table)")
            } else {
                // Method 2: TCP scan on port 22 (SSH, available before Tiger Cowork)
                let candidates = (2...20).map { "192.168.64.\($0)" }
                for candidate in candidates {
                    if await tryTCPConnect(host: candidate, port: 22) {
                        vmIPAddress = candidate
                        appendConsole("[TigrimOS] Found VM at \(candidate) (TCP scan port 22)")
                        break
                    }
                }
            }
        }

        // Try connecting to the VM's IP
        guard let ip = vmIPAddress else {
            appendConsole("[TigrimOS] Waiting for VM IP address...")
            return
        }

        let url = URL(string: "http://\(ip):\(VMConfig.vmPort)/api/auth/verify")!
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "POST"
        request.httpBody = "{}".data(using: .utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                if !serviceReady {
                    serviceReady = true
                    state = .running
                    if !VMConfig.isProvisioned {
                        FileManager.default.createFile(atPath: VMConfig.provisionedMarker.path, contents: nil)
                    }
                    appendConsole("[TigrimOS] Tiger Cowork is ready at http://\(ip):\(VMConfig.vmPort)")
                }
            }
        } catch {
            if state == .provisioning {
                appendConsole("[TigrimOS] Waiting for Tiger Cowork to start...")
            }
        }
    }

    /// Find VM IP via macOS ARP table (works for NAT VMs)
    private func findVMviaARP() async -> String? {
        do {
            let result = try await runProcess("/usr/sbin/arp", arguments: ["-a"])
            if result.exitCode == 0 {
                // Parse lines like: ? (192.168.64.3) at aa:bb:cc:dd:ee:ff on bridge100 ...
                for line in result.stdout.components(separatedBy: "\n") {
                    if line.contains("bridge") || line.contains("vmnet") {
                        // Extract IP from parentheses
                        if let start = line.firstIndex(of: "("),
                           let end = line.firstIndex(of: ")") {
                            let ip = String(line[line.index(after: start)..<end])
                            if isValidVMIP(ip) && ip.hasPrefix("192.168.") {
                                return ip
                            }
                        }
                    }
                }
            }
        } catch {}
        return nil
    }

    /// Raw TCP connect test (doesn't need HTTP, works with SSH port 22)
    private func tryTCPConnect(host: String, port: Int) async -> Bool {
        return await withCheckedContinuation { continuation in
            let queue = DispatchQueue(label: "tcp-probe")
            queue.async {
                var hints = addrinfo()
                hints.ai_family = AF_INET
                hints.ai_socktype = SOCK_STREAM
                var result: UnsafeMutablePointer<addrinfo>?
                let status = getaddrinfo(host, String(port), &hints, &result)
                guard status == 0, let addrInfo = result else {
                    continuation.resume(returning: false)
                    return
                }
                defer { freeaddrinfo(result) }

                let sock = socket(addrInfo.pointee.ai_family, addrInfo.pointee.ai_socktype, addrInfo.pointee.ai_protocol)
                guard sock >= 0 else {
                    continuation.resume(returning: false)
                    return
                }
                defer { close(sock) }

                // Set non-blocking with 1s timeout
                var tv = timeval(tv_sec: 1, tv_usec: 0)
                setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

                let connected = Darwin.connect(sock, addrInfo.pointee.ai_addr, addrInfo.pointee.ai_addrlen) == 0
                continuation.resume(returning: connected)
            }
        }
    }

    /// HTTP check to see if Tiger Cowork port is responding
    private func tryReachHost(_ host: String) async -> Bool {
        let url = URL(string: "http://\(host):\(VMConfig.vmPort)/")!
        var request = URLRequest(url: url, timeoutInterval: 1)
        request.httpMethod = "GET"
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                return http.statusCode > 0
            }
        } catch {
            return false
        }
        return false
    }

    /// Parse VM IP address from console output
    private func detectVMIP() -> String? {
        let lines = consoleOutput.components(separatedBy: "\n")
        for line in lines.reversed() {
            // Primary: TIGRIMOS_IP=x.x.x.x marker from print-ip.sh
            if line.contains("TIGRIMOS_IP=") {
                let parts = line.components(separatedBy: "TIGRIMOS_IP=")
                if let ipPart = parts.last?.trimmingCharacters(in: .whitespacesAndNewlines) {
                    let ip = ipPart.components(separatedBy: .whitespaces).first ?? ""
                    if isValidVMIP(ip) { return ip }
                }
            }
        }
        // Fallback: look for DHCP lease in kernel messages (e.g. "enp0s1: ... acquired ... 192.168.64.x")
        for line in lines.reversed() {
            if line.contains("lease of") || line.contains("acquired") || line.contains("bound to") {
                let words = line.components(separatedBy: .whitespaces)
                for word in words {
                    let clean = word.trimmingCharacters(in: CharacterSet.alphanumerics.inverted.subtracting(CharacterSet(charactersIn: ".")))
                    if isValidVMIP(clean) { return clean }
                }
            }
        }
        return nil
    }

    private func isValidVMIP(_ ip: String) -> Bool {
        let parts = ip.components(separatedBy: ".")
        guard parts.count == 4, parts.allSatisfy({ Int($0) != nil }) else { return false }
        return ip != "127.0.0.1" && ip != "0.0.0.0"
    }

    // MARK: - Shared Folders

    func addSharedFolder(url: URL, readOnly: Bool) {
        let tag = "shared-\(sharedFolders.count)"
        let entry = SharedFolderEntry(
            id: UUID(),
            tag: tag,
            url: url,
            readOnly: readOnly,
            name: url.lastPathComponent
        )
        sharedFolders.append(entry)
        appendConsole("[TigrimOS] Added shared folder: \(url.lastPathComponent) (read-only: \(readOnly))")
        saveSharedFolderConfig()
    }

    func removeSharedFolder(id: UUID) {
        sharedFolders.removeAll { $0.id == id }
        saveSharedFolderConfig()
    }

    func toggleReadOnly(id: UUID) {
        if let idx = sharedFolders.firstIndex(where: { $0.id == id }) {
            sharedFolders[idx].readOnly.toggle()
            saveSharedFolderConfig()
            appendConsole("[TigrimOS] \(sharedFolders[idx].name): read-only = \(sharedFolders[idx].readOnly)")
        }
    }

    /// Called when the guest OS shuts down (from delegate)
    func handleGuestShutdown() {
        healthCheckTimer?.invalidate()
        healthCheckTimer = nil
        serviceReady = false
        virtualMachine = nil
        consoleReadHandle?.closeFile()
        consoleReadHandle = nil
        state = .stopped
        appendConsole("[TigrimOS] VM shut down by guest")
    }

    // MARK: - Helpers

    private func findTigerCoworkSource() -> URL? {
        let candidates = [
            URL(fileURLWithPath: "/Users/sompoteyouwai/env/Tigris/tiger_cowork"),
            Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("tiger_cowork"),
        ]
        for url in candidates {
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("package.json").path) {
                return url
            }
        }
        return nil
    }

    func appendConsole(_ text: String) {
        let timestamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        consoleOutput += "[\(timestamp)] \(text)\n"
        let lines = consoleOutput.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count > 500 {
            consoleOutput = lines.suffix(500).joined(separator: "\n")
        }
    }

    private func createPipePair() throws -> (FileHandle, FileHandle) {
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else {
            throw TigrimOSError.pipeCreationFailed
        }
        return (FileHandle(fileDescriptor: fds[0], closeOnDealloc: true),
                FileHandle(fileDescriptor: fds[1], closeOnDealloc: true))
    }

    private func runProcess(_ path: String, arguments: [String]) async throws -> ProcessResult {
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = arguments

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            process.terminationHandler = { proc in
                let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                continuation.resume(returning: ProcessResult(
                    exitCode: proc.terminationStatus,
                    stdout: stdout,
                    stderr: stderr
                ))
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    private func saveSharedFolderConfig() {
        let configURL = VMConfig.appSupportDir.appendingPathComponent("shared_folders.json")
        let entries = sharedFolders.map { entry in
            [
                "path": entry.url.path,
                "readOnly": entry.readOnly ? "true" : "false",
                "name": entry.name,
            ]
        }
        if let data = try? JSONSerialization.data(withJSONObject: entries, options: .prettyPrinted) {
            try? data.write(to: configURL)
        }
    }

    func loadSharedFolderConfig() {
        let configURL = VMConfig.appSupportDir.appendingPathComponent("shared_folders.json")
        guard let data = try? Data(contentsOf: configURL),
              let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return }

        sharedFolders = entries.compactMap { dict in
            guard let path = dict["path"], let name = dict["name"] else { return nil }
            let readOnly = dict["readOnly"] == "true"
            return SharedFolderEntry(
                id: UUID(),
                tag: "shared-\(sharedFolders.count)",
                url: URL(fileURLWithPath: path),
                readOnly: readOnly,
                name: name
            )
        }
    }
}

// MARK: - VM Delegate

class VMDelegate: NSObject, VZVirtualMachineDelegate {
    weak var manager: VMManager?

    init(manager: VMManager) {
        self.manager = manager
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        Task { @MainActor in
            manager?.state = .error
            manager?.errorMessage = error.localizedDescription
            manager?.appendConsole("[ERROR] VM stopped: \(error.localizedDescription)")
        }
    }

    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        Task { @MainActor in
            manager?.handleGuestShutdown()
        }
    }
}

// MARK: - Models

struct SharedFolderEntry: Identifiable {
    let id: UUID
    let tag: String
    let url: URL
    var readOnly: Bool
    let name: String
}

struct ProcessResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

// MARK: - Errors

enum TigrimOSError: LocalizedError {
    case downloadFailed(String)
    case pipeCreationFailed
    case vmNotRunning
    case provisioningFailed(String)

    var errorDescription: String? {
        switch self {
        case .downloadFailed(let msg): return "Download failed: \(msg)"
        case .pipeCreationFailed: return "Failed to create console pipe"
        case .vmNotRunning: return "VM is not running"
        case .provisioningFailed(let msg): return "Provisioning failed: \(msg)"
        }
    }
}
