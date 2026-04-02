import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vmManager: VMManager
    @State private var showConsole = false
    @State private var selectedTab: Tab = .app

    enum Tab {
        case app, console, folders
    }

    var body: some View {
        VStack(spacing: 0) {
            // Top bar
            HStack {
                Image(systemName: "pawprint.fill")
                    .foregroundColor(.orange)
                    .font(.title2)
                Text("TigrimOS")
                    .font(.title2.bold())

                Spacer()

                // Status indicator
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 10, height: 10)
                    Text(vmManager.state.rawValue)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Spacer()

                // VM control buttons
                HStack(spacing: 12) {
                    if vmManager.state == .stopped || vmManager.state == .error {
                        Button {
                            Task { await vmManager.startVM() }
                        } label: {
                            Label("Start", systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                    } else if vmManager.state == .running {
                        Button {
                            Task { await vmManager.stopVM() }
                        } label: {
                            Label("Stop", systemImage: "stop.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.red)
                    } else {
                        ProgressView()
                            .scaleEffect(0.7)
                    }

                    // Tab switcher
                    Picker("", selection: $selectedTab) {
                        Image(systemName: "globe").tag(Tab.app)
                        Image(systemName: "terminal").tag(Tab.console)
                        Image(systemName: "folder.badge.gearshape").tag(Tab.folders)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)

            Divider()

            // Progress bar during download/setup
            if vmManager.state == .downloading {
                ProgressView(value: vmManager.progress)
                    .progressViewStyle(.linear)
                    .padding(.horizontal)
            }

            // Main content
            switch selectedTab {
            case .app:
                appView
            case .console:
                ConsoleView()
            case .folders:
                SharedFoldersView()
            }
        }
        .onAppear {
            vmManager.loadSharedFolderConfig()
        }
    }

    @ViewBuilder
    private var appView: some View {
        if vmManager.serviceReady, let ip = vmManager.vmIPAddress {
            TigerCoworkWebView(host: ip, port: VMConfig.vmPort)
        } else if vmManager.state == .stopped || vmManager.state == .error {
            VStack(spacing: 20) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 64))
                    .foregroundColor(.secondary)

                Text("Tiger Cowork is not running")
                    .font(.title3)
                    .foregroundColor(.secondary)

                if let error = vmManager.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                        .padding(.horizontal, 40)
                        .multilineTextAlignment(.center)
                }

                Button("Start TigrimOS") {
                    Task { await vmManager.startVM() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Text("Runs Tiger Cowork inside a secure Ubuntu sandbox")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 16) {
                ProgressView()
                    .scaleEffect(1.5)

                Text(vmManager.state.rawValue)
                    .font(.headline)

                Text("This may take a few minutes on first launch")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var statusColor: Color {
        switch vmManager.state {
        case .running: return vmManager.serviceReady ? .green : .yellow
        case .stopped: return .gray
        case .error: return .red
        case .downloading, .converting, .provisioning, .starting, .stopping: return .yellow
        }
    }
}
