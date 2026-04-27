import { FastifyInstance } from "fastify";
import { getSettings } from "../services/data";
import multipart from "@fastify/multipart";
import path from "path";
import fs from "fs";
import { createReadStream } from "fs";
import fsPromises from "fs/promises";

function validateLocalPath(mountPath: string, requestedPath: string): string {
  const resolved = path.resolve(mountPath, requestedPath);
  const root = path.resolve(mountPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Access denied: path outside mounted directory");
  }
  return resolved;
}

export async function localFilesRoutes(fastify: FastifyInstance) {
  // Helper to get and validate a mount
  async function getMount(mountId: string, requireWrite = false) {
    const settings = await getSettings();
    const mount = (settings.localFileMounts || []).find(m => m.id === mountId && m.enabled);
    if (!mount) throw new Error("Mount not found or disabled");
    if (requireWrite && mount.permissions !== "readwrite") {
      throw new Error("Write permission denied for this mount");
    }
    return mount;
  }

  // List all enabled mounts
  fastify.get("/", async (request, reply) => {
    const settings = await getSettings();
    return (settings.localFileMounts || []).filter(m => m.enabled).map(m => ({
      id: m.id,
      label: m.label,
      path: m.path,
      permissions: m.permissions,
      source: (m as any).source || undefined,
    }));
  });

  // Browse files in a mount
  fastify.get("/browse", async (request, reply) => {
    try {
      const { mountId, path: subPath } = request.query as any;
      if (!mountId) { reply.code(400); return { error: "mountId required" }; }
      const mount = await getMount(mountId);
      const resolved = validateLocalPath(mount.path, subPath || "");

      try {
        await fsPromises.access(resolved);
      } catch {
        return [];
      }

      const entries = await fsPromises.readdir(resolved, { withFileTypes: true });
      const results = await Promise.all(
        entries.map(async (entry) => {
          try {
            const stat = await fsPromises.stat(path.join(resolved, entry.name));
            return {
              name: entry.name,
              path: subPath ? path.join(subPath, entry.name) : entry.name,
              isDirectory: entry.isDirectory(),
              size: entry.isDirectory() ? 0 : stat.size,
              modified: stat.mtime.toISOString(),
            };
          } catch {
            return null;
          }
        })
      );
      return results.filter(Boolean);
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Read file
  fastify.get("/read", async (request, reply) => {
    try {
      const { mountId, path: filePath } = request.query as any;
      if (!mountId || !filePath) { reply.code(400); return { error: "mountId and path required" }; }
      const mount = await getMount(mountId);
      const resolved = validateLocalPath(mount.path, filePath);
      if (!fs.existsSync(resolved)) { reply.code(404); return { error: "File not found" }; }
      const content = await fsPromises.readFile(resolved, "utf-8");
      return { content, path: filePath, mountId };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Write file
  fastify.post("/write", async (request, reply) => {
    try {
      const { mountId, path: filePath, content } = request.body as any;
      if (!mountId || !filePath) { reply.code(400); return { error: "mountId and path required" }; }
      const mount = await getMount(mountId, true);
      const resolved = validateLocalPath(mount.path, filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fsPromises.writeFile(resolved, content || "");
      return { success: true, path: filePath };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Delete file
  fastify.delete("/", async (request, reply) => {
    try {
      const { mountId, path: filePath } = request.query as any;
      if (!mountId || !filePath) { reply.code(400); return { error: "mountId and path required" }; }
      const mount = await getMount(mountId, true);
      const resolved = validateLocalPath(mount.path, filePath);
      const stat = await fsPromises.stat(resolved);
      if (stat.isDirectory()) {
        await fsPromises.rm(resolved, { recursive: true });
      } else {
        await fsPromises.unlink(resolved);
      }
      return { success: true };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Mkdir
  fastify.post("/mkdir", async (request, reply) => {
    try {
      const { mountId, path: dirPath } = request.body as any;
      if (!mountId || !dirPath) { reply.code(400); return { error: "mountId and path required" }; }
      const mount = await getMount(mountId, true);
      const resolved = validateLocalPath(mount.path, dirPath);
      if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
      return { success: true, path: dirPath };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Download
  fastify.get("/download", async (request, reply) => {
    try {
      const { mountId, path: filePath } = request.query as any;
      if (!mountId || !filePath) { reply.code(400); return { error: "mountId and path required" }; }
      const mount = await getMount(mountId);
      const resolved = validateLocalPath(mount.path, filePath);
      const fileName = path.basename(resolved);
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(createReadStream(resolved));
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Upload — registered in its own sub-plugin so multipart doesn't interfere with JSON routes
  fastify.register(async function uploadPlugin(sub) {
    await sub.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    sub.post("/upload", async (request, reply) => {
      try {
        const data = await request.file();
        if (!data) { reply.code(400); return { error: "No file" }; }

        const buffer = await data.toBuffer();
        const originalname = data.filename;
        const pathField = data.fields?.path as any;
        const mountIdField = data.fields?.mountId as any;
        const mountId = mountIdField?.value;
        const destDir = pathField?.value || "";

        if (!mountId) { reply.code(400); return { error: "mountId required" }; }
        const mount = await getMount(mountId, true);

        const destPath = destDir ? destDir + "/" + originalname : originalname;
        const resolved = validateLocalPath(mount.path, destPath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, buffer);
        return { success: true, path: destPath };
      } catch (err: any) {
        reply.code(403); return { error: err.message };
      }
    });
  });

  // Validate a mount path exists on the host
  fastify.post("/validate-path", async (request, reply) => {
    try {
      const { path: dirPath } = request.body as any;
      if (!dirPath) { reply.code(400); return { error: "path required" }; }
      const resolved = path.resolve(dirPath);
      const exists = fs.existsSync(resolved);
      const isDir = exists && fs.statSync(resolved).isDirectory();
      return { exists, isDirectory: isDir, resolvedPath: resolved };
    } catch (err: any) {
      return { exists: false, isDirectory: false, error: err.message };
    }
  });

  // Auto-detect VM shared folders (UTM / VirtFS / SPICE / VirtualBox / VMware)
  fastify.get("/detect-shares", async (request, reply) => {
    const detected: Array<{ path: string; label: string; source: string; permissions: "read" | "readwrite" }> = [];

    // Parse /proc/mounts to get mount info: tag (device), mount point, fs type, options
    // UTM/QEMU 9p mounts look like: share_tag /mnt/shared-0 9p rw,relatime,...
    // The first column (device/tag) is the share name set in UTM
    interface MountInfo { tag: string; mountPoint: string; fsType: string; options: string; }
    const procMounts: MountInfo[] = [];
    const mountsByPath: Record<string, MountInfo> = {};

    try {
      const mountsFile = "/proc/mounts";
      if (fs.existsSync(mountsFile)) {
        const content = fs.readFileSync(mountsFile, "utf-8");
        for (const line of content.split("\n")) {
          const parts = line.split(/\s+/);
          if (parts.length < 4) continue;
          const info: MountInfo = { tag: parts[0], mountPoint: parts[1], fsType: parts[2], options: parts[3] };
          procMounts.push(info);
          mountsByPath[info.mountPoint] = info;
        }
      }
    } catch {}

    // Helper: check if a path is writable
    function getPermission(dirPath: string): "read" | "readwrite" {
      const info = mountsByPath[dirPath];
      if (info && info.options.split(",").includes("ro")) return "read";
      // Try writing a temp file to check actual write access
      try {
        const testFile = path.join(dirPath, ".tigrimos_write_test_" + Date.now());
        fs.writeFileSync(testFile, "");
        fs.unlinkSync(testFile);
        return "readwrite";
      } catch {
        return "read";
      }
    }

    // Helper: get a friendly label for a mount point
    // For VM shared folders (9p/virtiofs), use the mount tag (= UTM share name)
    // For others, use the directory name
    function getLabel(dirPath: string): string {
      const info = mountsByPath[dirPath];
      if (info && ["9p", "virtiofs", "vboxsf", "fuse.vmhgfs-fuse"].includes(info.fsType)) {
        // The tag is the share name from UTM/VirtualBox/VMware (e.g. "trial", "share")
        const tag = info.tag;
        // Skip generic tags like "share", "none", or numeric ones
        if (tag && tag !== "none" && tag !== "share" && !/^\d+$/.test(tag)) {
          return tag;
        }
      }
      return path.basename(dirPath);
    }

    // First: add all VM-specific mounts from /proc/mounts (9p, virtiofs, vboxsf, vmhgfs)
    const vmFsTypes = new Set(["9p", "virtiofs", "vboxsf", "fuse.vmhgfs-fuse"]);
    for (const m of procMounts) {
      if (!vmFsTypes.has(m.fsType)) continue;
      if (detected.some(d => d.path === m.mountPoint)) continue;
      const isRO = m.options.split(",").includes("ro");
      detected.push({
        path: m.mountPoint,
        label: getLabel(m.mountPoint),
        source: m.fsType,
        permissions: isRO ? "read" : "readwrite",
      });
    }

    // Then: scan common mount roots for any directories not yet detected
    const scanRoots = ["/mnt", "/media", "/media/share", "/media/psf", "/shared", "/host"];
    const skipNames = new Set(["cdrom", "floppy", "removable"]);

    for (const root of scanRoots) {
      try {
        if (!fs.existsSync(root)) continue;
        if (!fs.statSync(root).isDirectory()) continue;
        const children = fs.readdirSync(root, { withFileTypes: true });
        for (const child of children) {
          if (!child.isDirectory()) continue;
          if (skipNames.has(child.name) || child.name.startsWith(".")) continue;
          const fullPath = path.join(root, child.name);
          if (detected.some(d => d.path === fullPath)) continue;
          detected.push({
            path: fullPath,
            label: getLabel(fullPath),
            source: `Shared (${root})`,
            permissions: getPermission(fullPath),
          });
        }
      } catch {}
    }

    return detected;
  });
}
