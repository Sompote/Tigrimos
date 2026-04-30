import Foundation

/// Wraps Apple's `container` CLI to run TigrimOS as a lightweight Linux MicroVM.
/// Used by VMManager when activeBackend == .container.
///
/// Lifecycle parallel to VMManager's VM path:
///   ensureSystemReady → ensureImageBuilt → startContainer → startStreamingLogs
///   stopContainer (graceful) or resetContainer (also wipes image + volumes)
@MainActor
final class ContainerRuntime {
    static let cliPath = "/usr/local/bin/container"
    static let containerName = "tigrimos"
    static let imageTag = "tigrimos:latest"
    static let dataVolumeName = "tigrimos-data"
    static let uploadsVolumeName = "tigrimos-uploads"

    weak var manager: VMManager?

    private var logsProcess: Process?
    private var logsReadHandle: FileHandle?

    // MARK: - System

    /// Ensure the `container` system service is running. Idempotent.
    func ensureSystemReady() async throws {
        // `container system status` exits non-zero when the service isn't running.
        let status = try await CommandRunner.run(Self.cliPath, arguments: ["system", "status"])
        if status.exitCode == 0 {
            manager?.appendConsole("[TigrimOS] container system already running")
            return
        }

        manager?.appendConsole("[TigrimOS] Starting container system service...")
        let start = try await CommandRunner.run(Self.cliPath, arguments: ["system", "start"])
        guard start.exitCode == 0 else {
            throw TigrimOSError.provisioningFailed(
                "`container system start` failed: \(start.stderr.isEmpty ? start.stdout : start.stderr)"
            )
        }
        manager?.appendConsole("[TigrimOS] container system started")
    }

    // MARK: - Image

    /// Build the tigrimos:latest image from the local Dockerfile if it isn't already present.
    func ensureImageBuilt(buildContext: URL) async throws {
        // Check whether the image already exists.
        let listResult = try await CommandRunner.run(Self.cliPath, arguments: [
            "image", "list", "-q", Self.imageTag
        ])
        if listResult.exitCode == 0 && !listResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            manager?.appendConsole("[TigrimOS] Using cached image \(Self.imageTag)")
            return
        }

        // Verify the build context has a Dockerfile.
        let dockerfile = buildContext.appendingPathComponent("Dockerfile")
        guard FileManager.default.fileExists(atPath: dockerfile.path) else {
            throw TigrimOSError.provisioningFailed(
                "Dockerfile not found at \(dockerfile.path) — make sure tiger_cowork/ is next to TigrimOS.app"
            )
        }

        manager?.appendConsole("[TigrimOS] Building \(Self.imageTag) from \(buildContext.path) (first run, ~3-5 min)...")

        // Stream build output so the user sees progress in the Console tab.
        try await runStreaming(
            arguments: ["build", "-t", Self.imageTag, buildContext.path],
            failureMessage: "container build failed"
        )

        manager?.appendConsole("[TigrimOS] Image \(Self.imageTag) built successfully")
    }

    // MARK: - Run / Stop / Reset

    /// Start the container in detached mode with the configured port forwarding and volumes.
    func startContainer(sharedFolders: [SharedFolderEntry]) async throws {
        // Remove any lingering container with the same name (e.g. from a prior crash).
        _ = try? await CommandRunner.run(Self.cliPath, arguments: ["rm", "-f", Self.containerName])

        var args: [String] = [
            "run",
            "-d",
            "--rm",
            "--name", Self.containerName,
            "--memory", "\(VMConfig.containerMemoryGB)g",
            "--cpus", "\(VMConfig.containerCPUs)",
            "--publish", "127.0.0.1:\(VMConfig.vmPort):\(VMConfig.vmPort)",
            "--volume", "\(Self.dataVolumeName):/app/data",
            "--volume", "\(Self.uploadsVolumeName):/app/uploads",
        ]

        for entry in sharedFolders {
            let mountPoint = "/mnt/shared/\(entry.name)"
            let suffix = entry.readOnly ? ":ro" : ""
            args.append("--volume")
            args.append("\(entry.url.path):\(mountPoint)\(suffix)")
        }

        args.append(Self.imageTag)

        let result = try await CommandRunner.run(Self.cliPath, arguments: args)
        guard result.exitCode == 0 else {
            throw TigrimOSError.provisioningFailed(
                "container run failed: \(result.stderr.isEmpty ? result.stdout : result.stderr)"
            )
        }
        manager?.appendConsole("[TigrimOS] Container \(Self.containerName) started")
    }

    /// Gracefully stop the running container. Safe to call when nothing is running.
    func stopContainer() async throws {
        stopStreamingLogs()
        let result = try await CommandRunner.run(Self.cliPath, arguments: [
            "stop", "-t", "5", Self.containerName
        ])
        // exit code != 0 is fine when the container is already gone
        if result.exitCode == 0 {
            manager?.appendConsole("[TigrimOS] Container stopped")
        }
        // Belt-and-suspenders: --rm should remove it, but force in case it crashed.
        _ = try? await CommandRunner.run(Self.cliPath, arguments: ["rm", "-f", Self.containerName])
    }

    /// Stop the container, then delete its image and named volumes so the next start
    /// rebuilds from scratch. Mirrors VMManager.resetVM() for the container path.
    func resetContainer() async throws {
        try? await stopContainer()

        _ = try? await CommandRunner.run(Self.cliPath, arguments: ["image", "rm", Self.imageTag])
        _ = try? await CommandRunner.run(Self.cliPath, arguments: ["volume", "rm", Self.dataVolumeName])
        _ = try? await CommandRunner.run(Self.cliPath, arguments: ["volume", "rm", Self.uploadsVolumeName])

        manager?.appendConsole("[TigrimOS] Container, image, and volumes deleted — will rebuild on next start")
    }

    // MARK: - Logs

    /// Start streaming `container logs -f` into the manager's console output. Non-blocking.
    func startStreamingLogs() {
        stopStreamingLogs()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: Self.cliPath)
        process.arguments = ["logs", "-f", Self.containerName]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        let readHandle = pipe.fileHandleForReading
        readHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                self?.manager?.appendConsole(text.trimmingCharacters(in: .newlines))
            }
        }

        do {
            try process.run()
            self.logsProcess = process
            self.logsReadHandle = readHandle
        } catch {
            manager?.appendConsole("[WARN] Could not stream container logs: \(error.localizedDescription)")
        }
    }

    func stopStreamingLogs() {
        logsReadHandle?.readabilityHandler = nil
        logsReadHandle = nil
        if let process = logsProcess, process.isRunning {
            process.terminate()
        }
        logsProcess = nil
    }

    // MARK: - Streaming command helper

    /// Run a command and pipe its stdout/stderr into the manager's console as it runs.
    /// Used for long-running operations like `container build` where the user wants live progress.
    private func runStreaming(arguments: [String], failureMessage: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: Self.cliPath)
            process.arguments = arguments

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                Task { @MainActor [weak self] in
                    self?.manager?.appendConsole(text.trimmingCharacters(in: .newlines))
                }
            }

            process.terminationHandler = { proc in
                pipe.fileHandleForReading.readabilityHandler = nil
                if proc.terminationStatus == 0 {
                    continuation.resume(returning: ())
                } else {
                    continuation.resume(throwing: TigrimOSError.provisioningFailed(
                        "\(failureMessage) (exit code \(proc.terminationStatus))"
                    ))
                }
            }

            do {
                try process.run()
            } catch {
                pipe.fileHandleForReading.readabilityHandler = nil
                continuation.resume(throwing: error)
            }
        }
    }
}
