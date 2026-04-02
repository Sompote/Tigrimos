import SwiftUI

/// Shows VM console output — useful for debugging and monitoring
struct ConsoleView: View {
    @EnvironmentObject var vmManager: VMManager

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("VM Console")
                    .font(.headline)
                Spacer()
                Button("Clear") {
                    vmManager.consoleOutput = ""
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    Text(vmManager.consoleOutput.isEmpty ? "No output yet. Start the VM to see logs." : vmManager.consoleOutput)
                        .font(.system(.body, design: .monospaced))
                        .foregroundColor(.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .textSelection(.enabled)
                        .id("bottom")
                }
                .background(Color.black)
                .onChange(of: vmManager.consoleOutput) { _ in
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
        }
    }
}
