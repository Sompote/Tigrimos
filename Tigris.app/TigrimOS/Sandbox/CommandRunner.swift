import Foundation

/// Result of a process invocation.
struct ProcessResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

/// Shared helper for spawning subprocesses asynchronously.
/// Used by both VMManager (qemu-img, hdiutil, etc.) and ContainerRuntime (`container` CLI).
enum CommandRunner {
    /// Run a process to completion and return its exit code, stdout, and stderr.
    static func run(_ path: String, arguments: [String]) async throws -> ProcessResult {
        try await withCheckedThrowingContinuation { continuation in
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
}
