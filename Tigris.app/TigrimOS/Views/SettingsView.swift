import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var vmManager: VMManager
    @AppStorage("cpuCount") private var cpuCount = 4
    @AppStorage("memoryGB") private var memoryGB = 4
    @AppStorage("autoStart") private var autoStart = false
    @AppStorage("vmStoragePath") private var vmStoragePath = ""
    @State private var showResetAlert = false
    @State private var showMoveAlert = false
    @State private var pendingStoragePath = ""

    var body: some View {
        TabView {
            // General
            Form {
                Section("VM Resources") {
                    Picker("CPU Cores", selection: $cpuCount) {
                        ForEach(1...ProcessInfo.processInfo.processorCount, id: \.self) { count in
                            Text("\(count) cores").tag(count)
                        }
                    }

                    Picker("Memory", selection: $memoryGB) {
                        Text("2 GB").tag(2)
                        Text("4 GB").tag(4)
                        Text("8 GB").tag(8)
                    }

                    Text("Changes take effect after VM restart")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Section("VM Storage") {
                    LabeledContent("Location") {
                        Text(VMConfig.appSupportDir.path)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(2)
                    }

                    HStack {
                        Button("Change Location...") {
                            let panel = NSOpenPanel()
                            panel.canChooseFiles = false
                            panel.canChooseDirectories = true
                            panel.canCreateDirectories = true
                            panel.allowsMultipleSelection = false
                            panel.prompt = "Select VM Storage Folder"
                            panel.message = "Choose where to store the VM disk image and related files."

                            if panel.runModal() == .OK, let url = panel.url {
                                let newPath = url.appendingPathComponent("TigrimOS", isDirectory: true).path
                                pendingStoragePath = newPath
                                showMoveAlert = true
                            }
                        }

                        if !vmStoragePath.isEmpty {
                            Button("Reset to Default") {
                                pendingStoragePath = ""
                                showMoveAlert = true
                            }
                            .foregroundColor(.orange)
                        }
                    }

                    LabeledContent("Disk Image") {
                        Text(VMConfig.rawDiskPath.lastPathComponent)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    LabeledContent("Disk Usage") {
                        Text(VMConfig.diskUsage)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    LabeledContent("Max Disk Size") {
                        Text("\(VMConfig.diskSizeGB) GB")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Section("Startup") {
                    Toggle("Start VM automatically on launch", isOn: $autoStart)
                }

                Section("Maintenance") {
                    Button("Reset VM (re-provision)") {
                        showResetAlert = true
                    }
                    .foregroundColor(.red)

                    Button("Open VM Storage in Finder") {
                        NSWorkspace.shared.open(VMConfig.appSupportDir)
                    }
                }
            }
            .formStyle(.grouped)
            .tabItem {
                Label("General", systemImage: "gear")
            }

            // Security
            Form {
                Section("Sandbox Security") {
                    LabeledContent("Isolation") {
                        Text("Full VM (Virtualization.framework)")
                            .foregroundColor(.green)
                    }

                    LabeledContent("Network") {
                        Text("NAT — VM can access internet, host sees only port \(VMConfig.hostForwardPort)")
                    }

                    LabeledContent("File System") {
                        Text("Completely isolated. Only shared folders are accessible.")
                            .foregroundColor(.green)
                    }

                    LabeledContent("Process Isolation") {
                        Text("VM processes cannot see or affect host processes")
                            .foregroundColor(.green)
                    }
                }

                Section("Shared Folder Policy") {
                    Text("Folders are shared via VirtioFS, mounted inside the VM.")
                    Text("Default permission: Read-only. Write access requires explicit toggle per folder.")
                    Text("The TigrimOS source is mounted read-only and copied into the VM.")
                }
                .font(.caption)
            }
            .formStyle(.grouped)
            .tabItem {
                Label("Security", systemImage: "shield")
            }

            // About
            VStack(spacing: 16) {
                if let iconImage = NSImage(named: "AppIcon") {
                    Image(nsImage: iconImage)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 96, height: 96)
                } else {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 96, height: 96)
                }

                Text("TigrimOS")
                    .font(.largeTitle.bold())

                Text("v1.0.0")
                    .foregroundColor(.secondary)

                Text("Secure sandbox for TigrimOS")
                    .font(.subheadline)

                Divider()
                    .frame(width: 200)

                VStack(spacing: 8) {
                    Text("TigrimOS Swarm Agents")
                    Text("Ubuntu 22.04 VM via Virtualization.framework")
                    Text("Node.js 20 + Python 3 + Fastify")
                }
                .font(.caption)
                .foregroundColor(.secondary)

                Spacer()
            }
            .padding(.top, 40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .tabItem {
                Label("About", systemImage: "info.circle")
            }
        }
        .frame(width: 500, height: 420)
        .alert("Reset VM?", isPresented: $showResetAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) {
                Task { await vmManager.resetVM() }
            }
        } message: {
            Text("This will stop the VM and re-provision it on next start. Your shared folder configurations will be preserved.")
        }
        .alert("Change VM Storage?", isPresented: $showMoveAlert) {
            Button("Cancel", role: .cancel) {
                pendingStoragePath = ""
            }
            Button("Change & Restart", role: .destructive) {
                VMConfig.setStoragePath(pendingStoragePath.isEmpty ? nil : pendingStoragePath)
                vmStoragePath = pendingStoragePath
                pendingStoragePath = ""
                // Ensure new directory exists
                try? FileManager.default.createDirectory(
                    at: VMConfig.appSupportDir,
                    withIntermediateDirectories: true
                )
            }
        } message: {
            if pendingStoragePath.isEmpty {
                Text("Reset storage to default location?\n\n\(VMConfig.defaultAppSupportDir.path)\n\nExisting VM files at the custom location will not be deleted. You need to restart the app after changing.")
            } else {
                Text("Change VM storage to:\n\n\(pendingStoragePath)\n\nExisting VM files will not be moved automatically. You can manually move them or let TigrimOS re-download on next start. You need to restart the app after changing.")
            }
        }
    }
}
