import Foundation

/// Controls and audits file access between the host and the VM sandbox
class FileAccessControl: ObservableObject {
    struct AccessEntry: Identifiable, Codable {
        let id: UUID
        let path: String
        let permission: Permission
        let grantedAt: Date
        var revoked: Bool

        enum Permission: String, Codable {
            case readOnly = "read-only"
            case readWrite = "read-write"
        }
    }

    struct AuditLogEntry: Codable {
        let timestamp: Date
        let action: String
        let path: String
        let detail: String
    }

    @Published private(set) var accessEntries: [AccessEntry] = []
    @Published private(set) var auditLog: [AuditLogEntry] = []

    private let configURL: URL
    private let auditURL: URL

    init() {
        configURL = VMConfig.appSupportDir.appendingPathComponent("file_access.json")
        auditURL = VMConfig.appSupportDir.appendingPathComponent("audit_log.json")
        load()
    }

    /// Grant access to a path
    func grantAccess(path: String, permission: AccessEntry.Permission) {
        let entry = AccessEntry(
            id: UUID(),
            path: path,
            permission: permission,
            grantedAt: Date(),
            revoked: false
        )
        accessEntries.append(entry)
        logAudit(action: "GRANT", path: path, detail: "Permission: \(permission.rawValue)")
        save()
    }

    /// Revoke access to a path
    func revokeAccess(id: UUID) {
        if let idx = accessEntries.firstIndex(where: { $0.id == id }) {
            let path = accessEntries[idx].path
            accessEntries[idx].revoked = true
            logAudit(action: "REVOKE", path: path, detail: "Access revoked")
            save()
        }
    }

    /// Check if a path has active access
    func hasAccess(path: String) -> AccessEntry.Permission? {
        let active = accessEntries.first { entry in
            !entry.revoked && path.hasPrefix(entry.path)
        }
        return active?.permission
    }

    /// Check if write is allowed
    func canWrite(path: String) -> Bool {
        return hasAccess(path: path) == .readWrite
    }

    private func logAudit(action: String, path: String, detail: String) {
        let entry = AuditLogEntry(
            timestamp: Date(),
            action: action,
            path: path,
            detail: detail
        )
        auditLog.append(entry)
        // Keep last 1000 entries
        if auditLog.count > 1000 {
            auditLog = Array(auditLog.suffix(1000))
        }
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(accessEntries) {
            try? data.write(to: configURL)
        }
        if let data = try? encoder.encode(auditLog) {
            try? data.write(to: auditURL)
        }
    }

    private func load() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: configURL),
           let entries = try? decoder.decode([AccessEntry].self, from: data) {
            accessEntries = entries
        }
        if let data = try? Data(contentsOf: auditURL),
           let log = try? decoder.decode([AuditLogEntry].self, from: data) {
            auditLog = log
        }
    }
}
