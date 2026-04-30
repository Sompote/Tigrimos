import Foundation

/// User-selectable sandbox backend preference. Persisted in UserDefaults.
enum SandboxBackend: String, Codable, CaseIterable {
    case auto       // Pick the best available backend at start time
    case container  // Apple `container` CLI (lightweight MicroVM)
    case vm         // Apple Virtualization.framework full VM (legacy)

    var displayName: String {
        switch self {
        case .auto:      return "Auto (recommended)"
        case .container: return "Apple Container — Lightweight (~1 GB)"
        case .vm:        return "Apple Virtualization VM — Full Ubuntu (4 GB)"
        }
    }
}

/// The backend actually running this launch (resolved from SandboxBackend at start time).
enum ActiveBackend: String {
    case container
    case vm
}

/// Result of a backend availability probe.
struct BackendAvailability {
    let containerAvailable: Bool
    /// Human-readable reason container is unavailable. nil when available.
    let containerReason: String?
}

/// Path to the Apple `container` CLI installed by the official .pkg.
private let appleContainerCLIPath = "/usr/local/bin/container"

/// Detects which backends can run on this machine and resolves user preference to a concrete backend.
enum BackendSelector {
    /// Probe the machine for backend availability.
    static func detect() -> BackendAvailability {
        // Apple container is Apple Silicon only.
        #if !arch(arm64)
        return BackendAvailability(
            containerAvailable: false,
            containerReason: "Apple container requires Apple Silicon"
        )
        #else
        // Apple container needs the new virtualization features added in macOS 26.
        let osVersion = ProcessInfo.processInfo.operatingSystemVersion
        guard osVersion.majorVersion >= 26 else {
            return BackendAvailability(
                containerAvailable: false,
                containerReason: "Apple container requires macOS 26 or later"
            )
        }

        // The CLI must be installed.
        guard FileManager.default.isExecutableFile(atPath: appleContainerCLIPath) else {
            return BackendAvailability(
                containerAvailable: false,
                containerReason: "`container` CLI not installed — see https://github.com/apple/container"
            )
        }

        return BackendAvailability(containerAvailable: true, containerReason: nil)
        #endif
    }

    /// Convert a user preference into a concrete backend, given the current machine's capabilities.
    /// `.auto` picks container when available, VM otherwise. `.container` falls back to VM
    /// if the container backend is unavailable; the caller should surface the fallback to the user.
    static func resolve(_ preference: SandboxBackend) -> (backend: ActiveBackend, fellBack: Bool, reason: String?) {
        let availability = detect()
        switch preference {
        case .auto:
            if availability.containerAvailable {
                return (.container, false, nil)
            }
            return (.vm, false, availability.containerReason)
        case .container:
            if availability.containerAvailable {
                return (.container, false, nil)
            }
            return (.vm, true, availability.containerReason)
        case .vm:
            return (.vm, false, nil)
        }
    }
}
