import Foundation
import AppKit

/// Manages security-scoped bookmarks for persistent folder access
class SandboxManager {
    private static let bookmarksKey = "securityBookmarks"

    /// Save a security-scoped bookmark for a URL (persists access across launches)
    static func saveBookmark(for url: URL) throws {
        let bookmarkData = try url.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )

        var bookmarks = loadBookmarks()
        bookmarks[url.path] = bookmarkData
        UserDefaults.standard.set(
            bookmarks.mapValues { $0.base64EncodedString() },
            forKey: bookmarksKey
        )
    }

    /// Resolve a security-scoped bookmark
    static func resolveBookmark(for path: String) -> URL? {
        let bookmarks = loadBookmarks()
        guard let data = bookmarks[path] else { return nil }

        var isStale = false
        guard let url = try? URL(
            resolvingBookmarkData: data,
            options: .withSecurityScope,
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        ) else { return nil }

        if isStale {
            // Re-save the bookmark
            try? saveBookmark(for: url)
        }

        return url
    }

    /// Start accessing all saved security-scoped resources
    static func startAccessingAllResources() -> [URL] {
        let bookmarks = loadBookmarks()
        var accessedURLs: [URL] = []

        for (_, data) in bookmarks {
            var isStale = false
            if let url = try? URL(
                resolvingBookmarkData: data,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            ) {
                if url.startAccessingSecurityScopedResource() {
                    accessedURLs.append(url)
                }
            }
        }

        return accessedURLs
    }

    /// Remove bookmark for a path
    static func removeBookmark(for path: String) {
        var bookmarks = loadBookmarks()
        bookmarks.removeValue(forKey: path)
        UserDefaults.standard.set(
            bookmarks.mapValues { $0.base64EncodedString() },
            forKey: bookmarksKey
        )
    }

    private static func loadBookmarks() -> [String: Data] {
        guard let stored = UserDefaults.standard.dictionary(forKey: bookmarksKey) as? [String: String] else {
            return [:]
        }
        return stored.compactMapValues { Data(base64Encoded: $0) }
    }
}

/// Validates paths to prevent directory traversal attacks
struct PathValidator {
    /// Ensure a path stays within the allowed root
    static func validate(path: String, root: String) throws -> String {
        let resolved = (path as NSString).standardizingPath
        let rootResolved = (root as NSString).standardizingPath

        guard resolved.hasPrefix(rootResolved) else {
            throw PathValidationError.outsideRoot
        }

        // Block symlinks that escape the root
        let attrs = try FileManager.default.attributesOfItem(atPath: resolved)
        if let type = attrs[.type] as? FileAttributeType, type == .typeSymbolicLink {
            let target = try FileManager.default.destinationOfSymbolicLink(atPath: resolved)
            let resolvedTarget = (target as NSString).standardizingPath
            guard resolvedTarget.hasPrefix(rootResolved) else {
                throw PathValidationError.symlinkEscape
            }
        }

        return resolved
    }
}

enum PathValidationError: LocalizedError {
    case outsideRoot
    case symlinkEscape

    var errorDescription: String? {
        switch self {
        case .outsideRoot: return "Access denied: path outside sandbox"
        case .symlinkEscape: return "Access denied: symlink points outside sandbox"
        }
    }
}
