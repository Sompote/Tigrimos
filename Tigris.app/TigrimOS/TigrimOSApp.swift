import SwiftUI

@main
struct TigrimOSApp: App {
    @StateObject private var vmManager = VMManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vmManager)
                .frame(minWidth: 1100, minHeight: 700)
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        Settings {
            SettingsView()
                .environmentObject(vmManager)
        }
    }
}
