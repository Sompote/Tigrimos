import path from "path";
import fs from "fs/promises";
import fsSync from "fs";

export function validatePath(sandboxDir: string, requestedPath: string): string {
  const resolved = path.resolve(sandboxDir, requestedPath);
  const root = path.resolve(sandboxDir);
  if (!resolved.startsWith(root)) {
    throw new Error("Access denied: path outside workspace");
  }
  return resolved;
}

export async function listFiles(sandboxDir: string, subPath: string = ""): Promise<any[]> {
  const dir = validatePath(sandboxDir, subPath);
  try {
    await fs.access(dir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const stat = await fs.stat(path.join(dir, entry.name));
      return {
        name: entry.name,
        path: path.join(subPath, entry.name),
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : stat.size,
        modified: stat.mtime.toISOString(),
      };
    })
  );
  return results;
}

export async function readFile(sandboxDir: string, filePath: string): Promise<string> {
  const resolved = validatePath(sandboxDir, filePath);
  return fs.readFile(resolved, "utf-8");
}

export async function writeFile(sandboxDir: string, filePath: string, content: string): Promise<void> {
  const resolved = validatePath(sandboxDir, filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolved, content);
}

export async function deleteFile(sandboxDir: string, filePath: string): Promise<void> {
  const resolved = validatePath(sandboxDir, filePath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    await fs.rm(resolved, { recursive: true });
  } else {
    await fs.unlink(resolved);
  }
}
