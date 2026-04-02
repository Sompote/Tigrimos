import SwiftUI

/// First-run setup wizard shown when VM hasn't been provisioned yet
struct SetupView: View {
    @EnvironmentObject var vmManager: VMManager
    @State private var step = 0
    @State private var agreedToSecurity = false

    var body: some View {
        VStack(spacing: 0) {
            // Step indicator
            HStack(spacing: 20) {
                ForEach(0..<3) { i in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(i <= step ? Color.orange : Color.gray.opacity(0.3))
                            .frame(width: 24, height: 24)
                            .overlay {
                                if i < step {
                                    Image(systemName: "checkmark")
                                        .font(.caption2.bold())
                                        .foregroundColor(.white)
                                } else {
                                    Text("\(i + 1)")
                                        .font(.caption2.bold())
                                        .foregroundColor(i == step ? .white : .gray)
                                }
                            }
                        if i < 2 {
                            Rectangle()
                                .fill(i < step ? Color.orange : Color.gray.opacity(0.3))
                                .frame(width: 40, height: 2)
                        }
                    }
                }
            }
            .padding(.top, 20)

            Spacer()

            // Step content
            switch step {
            case 0:
                welcomeStep
            case 1:
                securityStep
            case 2:
                readyStep
            default:
                EmptyView()
            }

            Spacer()

            // Navigation
            HStack {
                if step > 0 {
                    Button("Back") { step -= 1 }
                        .buttonStyle(.bordered)
                }
                Spacer()
                if step < 2 {
                    Button("Next") { step += 1 }
                        .buttonStyle(.borderedProminent)
                        .disabled(step == 1 && !agreedToSecurity)
                } else {
                    Button("Start TigrimOS") {
                        Task { await vmManager.startVM() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
            }
            .padding()
        }
    }

    private var welcomeStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "pawprint.fill")
                .font(.system(size: 72))
                .foregroundColor(.orange)

            Text("Welcome to TigrimOS")
                .font(.largeTitle.bold())

            Text("Tiger Cowork runs inside a secure Ubuntu sandbox\non your Mac. No Docker required.")
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: 12) {
                featureRow(icon: "shield.checkered", text: "Full VM isolation via Apple Virtualization")
                featureRow(icon: "lock.fill", text: "Host files only accessible with your permission")
                featureRow(icon: "bolt.fill", text: "Native performance on Apple Silicon")
                featureRow(icon: "arrow.down.circle", text: "~2GB download for Ubuntu base image")
            }
            .padding(.top, 10)
        }
        .padding(.horizontal, 40)
    }

    private var securityStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "shield.lefthalf.filled")
                .font(.system(size: 48))
                .foregroundColor(.green)

            Text("Security Model")
                .font(.title.bold())

            VStack(alignment: .leading, spacing: 16) {
                securityRow(
                    icon: "desktopcomputer",
                    title: "VM Isolation",
                    detail: "Tiger Cowork runs in a real Ubuntu VM. It cannot access your Mac's processes, files, or network except through controlled channels."
                )
                securityRow(
                    icon: "folder.badge.questionmark",
                    title: "File Access",
                    detail: "No host folders are shared by default. You explicitly choose which folders to share, and whether they're read-only or read-write."
                )
                securityRow(
                    icon: "network",
                    title: "Network",
                    detail: "The VM uses NAT networking. Only port 3001 is forwarded to your Mac for the web UI."
                )
            }
            .padding(.horizontal, 20)

            Toggle(isOn: $agreedToSecurity) {
                Text("I understand the security model")
                    .font(.body)
            }
            .toggleStyle(.checkbox)
            .padding(.top, 10)
        }
        .padding(.horizontal, 40)
    }

    private var readyStep: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundColor(.green)

            Text("Ready to Go")
                .font(.title.bold())

            Text("TigrimOS will now:")
                .font(.body)

            VStack(alignment: .leading, spacing: 12) {
                stepRow(number: 1, text: "Download Ubuntu 22.04 cloud image (~700MB)")
                stepRow(number: 2, text: "Create a \(VMConfig.diskSizeGB)GB virtual disk")
                stepRow(number: 3, text: "Install Node.js 20, Python 3, and dependencies")
                stepRow(number: 4, text: "Deploy Tiger Cowork inside the VM")
                stepRow(number: 5, text: "Start the web UI at localhost:\(VMConfig.hostForwardPort)")
            }

            Text("First setup takes about 5-10 minutes.\nSubsequent starts are much faster.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 40)
    }

    private func featureRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .frame(width: 24)
                .foregroundColor(.orange)
            Text(text)
        }
    }

    private func securityRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .frame(width: 28)
                .foregroundColor(.blue)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.bold())
                Text(detail).font(.caption).foregroundColor(.secondary)
            }
        }
    }

    private func stepRow(number: Int, text: String) -> some View {
        HStack(spacing: 12) {
            Text("\(number)")
                .font(.caption.bold())
                .frame(width: 24, height: 24)
                .background(Color.orange)
                .foregroundColor(.white)
                .clipShape(Circle())
            Text(text)
                .font(.body)
        }
    }
}
