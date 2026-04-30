import Foundation
import AppKit

/// Opens macOS Terminal.app at a shell inside the active sandbox.
/// - For the container backend: `container exec -it tigrimos /bin/sh`.
/// - For the VM backend: SSH into the VM at the detected IP (password is `tigris`).
@MainActor
enum SandboxTerminalLauncher {
    static func launch(activeBackend: ActiveBackend, vmIPAddress: String?) {
        let command: String
        switch activeBackend {
        case .container:
            command = "\(ContainerRuntime.cliPath) exec -it \(ContainerRuntime.containerName) /bin/sh"
        case .vm:
            guard let ip = vmIPAddress else {
                showAlert(title: "Sandbox not running",
                          message: "Start the sandbox first to open a terminal session.")
                return
            }
            command = "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null tigris@\(ip)"
        }

        let script = """
        tell application "Terminal"
            do script "\(command)"
            activate
        end tell
        """

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        try? task.run()
    }

    private static func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}
