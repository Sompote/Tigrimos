import Foundation

/// All VM and app configuration constants
struct VMConfig {
    /// Default Application Support directory
    static let defaultAppSupportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("TigrimOS", isDirectory: true)
    }()

    /// Custom storage path (persisted in UserDefaults)
    static var appSupportDir: URL {
        if let custom = UserDefaults.standard.string(forKey: "vmStoragePath"),
           !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        return defaultAppSupportDir
    }

    /// Set a custom storage path
    static func setStoragePath(_ path: String?) {
        if let path = path, !path.isEmpty {
            UserDefaults.standard.set(path, forKey: "vmStoragePath")
        } else {
            UserDefaults.standard.removeObject(forKey: "vmStoragePath")
        }
    }

    /// Where the raw disk image lives (converted from QCOW2)
    static var rawDiskPath: URL { appSupportDir.appendingPathComponent("ubuntu-raw.img") }

    /// Where the QCOW2 cloud image is cached
    static var cloudImagePath: URL { appSupportDir.appendingPathComponent("ubuntu-cloud.qcow2") }

    /// Where the kernel (vmlinuz) lives
    static var kernelPath: URL { appSupportDir.appendingPathComponent("vmlinuz") }

    /// Where the initrd lives
    static var initrdPath: URL { appSupportDir.appendingPathComponent("initrd") }

    /// Cloud-init seed ISO
    static var seedISOPath: URL { appSupportDir.appendingPathComponent("seed.img") }

    /// EFI variable store (kept for compatibility)
    static var efiStorePath: URL { appSupportDir.appendingPathComponent("efi_vars.fd") }

    /// Machine identifier
    static var machineIdPath: URL { appSupportDir.appendingPathComponent("machine_id.bin") }

    /// Shared folder on host (user-controlled)
    static let defaultSharedDir: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent("TigrimOS_Shared", isDirectory: true)
    }()

    /// VM settings
    static let cpuCount: Int = min(4, ProcessInfo.processInfo.processorCount)
    static let memoryGB: UInt64 = 4
    static let memorySizeBytes: UInt64 = memoryGB * 1024 * 1024 * 1024
    static let diskSizeGB: Int = 5
    static let diskSizeBytes: UInt64 = UInt64(diskSizeGB) * 1024 * 1024 * 1024

    /// Networking
    static let vmPort: Int = 3001
    static let hostForwardPort: Int = 3001

    /// Provisioning marker
    static var provisionedMarker: URL { appSupportDir.appendingPathComponent(".provisioned") }

    /// Check if VM has been set up
    static var isProvisioned: Bool {
        FileManager.default.fileExists(atPath: provisionedMarker.path)
    }

    /// Disk size of raw image in human-readable format
    static var diskUsage: String {
        let path = rawDiskPath.path
        guard FileManager.default.fileExists(atPath: path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attrs[.size] as? UInt64 else {
            return "Not created"
        }
        let gb = Double(size) / (1024 * 1024 * 1024)
        return String(format: "%.1f GB", gb)
    }

    /// Ensure app support directory exists
    static func ensureDirectories() throws {
        try FileManager.default.createDirectory(at: appSupportDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: defaultSharedDir, withIntermediateDirectories: true)
    }

    // MARK: - Sandbox Backend

    /// User's preferred sandbox backend. Defaults to .auto on first launch.
    static var preferredBackend: SandboxBackend {
        get {
            guard let raw = UserDefaults.standard.string(forKey: "sandboxBackend"),
                  let backend = SandboxBackend(rawValue: raw) else {
                return .auto
            }
            return backend
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "sandboxBackend") }
    }

    /// Resource limits passed to `container run --memory/--cpus` when the container backend is active.
    /// The container's MicroVM right-sizes to these limits, so 1GB/2 CPUs uses far less than the VM's 4GB.
    static let containerMemoryGB: Int = 1
    static let containerCPUs: Int = 2
}
