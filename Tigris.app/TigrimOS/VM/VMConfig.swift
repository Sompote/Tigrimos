import Foundation

/// All VM and app configuration constants
struct VMConfig {
    /// Application support directory for TigrimOS
    static let appSupportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("TigrimOS", isDirectory: true)
    }()

    /// Where the raw disk image lives (converted from QCOW2)
    static let rawDiskPath: URL = appSupportDir.appendingPathComponent("ubuntu-raw.img")

    /// Where the QCOW2 cloud image is cached
    static let cloudImagePath: URL = appSupportDir.appendingPathComponent("ubuntu-cloud.qcow2")

    /// Where the kernel (vmlinuz) lives
    static let kernelPath: URL = appSupportDir.appendingPathComponent("vmlinuz")

    /// Where the initrd lives
    static let initrdPath: URL = appSupportDir.appendingPathComponent("initrd")

    /// Cloud-init seed ISO
    static let seedISOPath: URL = appSupportDir.appendingPathComponent("seed.img")

    /// EFI variable store (kept for compatibility)
    static let efiStorePath: URL = appSupportDir.appendingPathComponent("efi_vars.fd")

    /// Machine identifier
    static let machineIdPath: URL = appSupportDir.appendingPathComponent("machine_id.bin")

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
    static let provisionedMarker: URL = appSupportDir.appendingPathComponent(".provisioned")

    /// Check if VM has been set up
    static var isProvisioned: Bool {
        FileManager.default.fileExists(atPath: provisionedMarker.path)
    }

    /// Ensure app support directory exists
    static func ensureDirectories() throws {
        try FileManager.default.createDirectory(at: appSupportDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: defaultSharedDir, withIntermediateDirectories: true)
    }
}
