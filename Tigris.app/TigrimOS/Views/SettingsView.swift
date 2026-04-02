import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var vmManager: VMManager
    @AppStorage("cpuCount") private var cpuCount = 4
    @AppStorage("memoryGB") private var memoryGB = 4
    @AppStorage("autoStart") private var autoStart = false
    @State private var showResetAlert = false

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

                    HStack {
                        Text("Storage location:")
                        Text(VMConfig.appSupportDir.path)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .textSelection(.enabled)
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
                    Text("The Tiger Cowork source is mounted read-only and copied into the VM.")
                }
                .font(.caption)
            }
            .formStyle(.grouped)
            .tabItem {
                Label("Security", systemImage: "shield")
            }

            // About
            VStack(spacing: 16) {
                Image(systemName: "pawprint.fill")
                    .font(.system(size: 64))
                    .foregroundColor(.orange)

                Text("TigrimOS")
                    .font(.largeTitle.bold())

                Text("v1.0.0")
                    .foregroundColor(.secondary)

                Text("Secure sandbox for Tiger Cowork")
                    .font(.subheadline)

                Divider()
                    .frame(width: 200)

                VStack(spacing: 8) {
                    Text("Tiger Cowork v0.4.3")
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
        .frame(width: 500, height: 400)
        .alert("Reset VM?", isPresented: $showResetAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Reset", role: .destructive) {
                Task { await vmManager.resetVM() }
            }
        } message: {
            Text("This will stop the VM and re-provision it on next start. Your shared folder configurations will be preserved.")
        }
    }
}
