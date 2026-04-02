import SwiftUI

/// Manages host filesystem folders shared with the sandbox VM
struct SharedFoldersView: View {
    @EnvironmentObject var vmManager: VMManager
    @State private var showFilePicker = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Shared Folders")
                        .font(.headline)
                    Text("Only these folders are accessible inside the sandbox. All others are isolated.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Button {
                    showFilePicker = true
                } label: {
                    Label("Add Folder", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()

            Divider()

            if vmManager.sharedFolders.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 48))
                        .foregroundColor(.secondary)

                    Text("No shared folders")
                        .font(.title3)
                        .foregroundColor(.secondary)

                    Text("The VM is fully isolated from your file system.\nAdd folders here to grant controlled access.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    Section {
                        ForEach(vmManager.sharedFolders) { entry in
                            SharedFolderRow(entry: entry)
                        }
                    } header: {
                        HStack {
                            Text("Folder")
                            Spacer()
                            Text("Permission")
                                .frame(width: 120)
                            Text("")
                                .frame(width: 40)
                        }
                    }
                }
            }

            // Security notice
            HStack(spacing: 8) {
                Image(systemName: "shield.checkered")
                    .foregroundColor(.green)
                Text("Security: Changes require VM restart to take effect. Write access must be explicitly granted per folder.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            .padding()
            .background(.ultraThinMaterial)
        }
        .fileImporter(
            isPresented: $showFilePicker,
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                if let url = urls.first {
                    // Start security-scoped access
                    let didAccess = url.startAccessingSecurityScopedResource()
                    vmManager.addSharedFolder(url: url, readOnly: true)
                    if didAccess {
                        url.stopAccessingSecurityScopedResource()
                    }
                }
            case .failure(let error):
                vmManager.appendConsole("[ERROR] Failed to add folder: \(error.localizedDescription)")
            }
        }
    }
}

struct SharedFolderRow: View {
    @EnvironmentObject var vmManager: VMManager
    let entry: SharedFolderEntry

    var body: some View {
        HStack {
            Image(systemName: "folder.fill")
                .foregroundColor(.blue)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(.body.bold())
                Text(entry.url.path)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            // Permission toggle
            Button {
                vmManager.toggleReadOnly(id: entry.id)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: entry.readOnly ? "lock.fill" : "lock.open.fill")
                    Text(entry.readOnly ? "Read Only" : "Read & Write")
                }
                .font(.caption)
                .foregroundColor(entry.readOnly ? .green : .orange)
            }
            .buttonStyle(.bordered)
            .frame(width: 130)

            // Remove
            Button {
                vmManager.removeSharedFolder(id: entry.id)
            } label: {
                Image(systemName: "trash")
                    .foregroundColor(.red)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }
}
