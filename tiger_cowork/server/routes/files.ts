import { FastifyInstance } from "fastify";
import { listFiles, readFile, writeFile, deleteFile, validatePath } from "../services/sandbox";
import multipart from "@fastify/multipart";
import path from "path";
import fs from "fs";
import { createReadStream } from "fs";
import mammoth from "mammoth";
// @ts-ignore
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";

const ALLOWED_CHAT_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".json", ".xml",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg",
  ".py", ".js", ".ts", ".html", ".css", ".md", ".yaml", ".yml",
  ".zip", ".tar", ".gz",
];

export async function filesRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  fastify.get("/", async (request, reply) => {
    try {
      const subPath = (request.query as any).path || "";
      const files = await listFiles(request.server.sandboxDir, subPath);
      return files;
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  fastify.get("/read", async (request, reply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) { reply.code(400); return { error: "path required" }; }
      const content = await readFile(request.server.sandboxDir, filePath);
      return { content, path: filePath };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  fastify.post("/write", async (request, reply) => {
    try {
      const { path: filePath, content } = request.body as any;
      if (!filePath) { reply.code(400); return { error: "path required" }; }
      await writeFile(request.server.sandboxDir, filePath, content || "");
      return { success: true, path: filePath };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  fastify.delete("/", async (request, reply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) { reply.code(400); return { error: "path required" }; }
      await deleteFile(request.server.sandboxDir, filePath);
      return { success: true };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Mkdir
  fastify.post("/mkdir", async (request, reply) => {
    try {
      const dirPath = (request.body as any).path;
      if (!dirPath) { reply.code(400); return { error: "path required" }; }
      const resolved = validatePath(request.server.sandboxDir, dirPath);
      if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
      return { success: true, path: dirPath };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Upload
  fastify.post("/upload", async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) { reply.code(400); return { error: "No file" }; }

      const buffer = await data.toBuffer();
      const originalname = data.filename;

      // Extract path field from multipart fields
      const pathField = data.fields?.path as any;
      const destDir = pathField?.value || "";
      const destPath = destDir ? destDir + "/" + originalname : originalname;
      const resolved = validatePath(request.server.sandboxDir, destPath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved, buffer);
      return { success: true, path: destPath };
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });

  // Chat file upload (multiple files, saved to uploads/ in sandbox)
  fastify.post("/chat-upload", async (request, reply) => {
    try {
      const parts = request.files();
      const sandboxDir = request.server.sandboxDir;
      const uploadsDir = path.join(sandboxDir, "uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const uploaded: { name: string; path: string; size: number; type: string }[] = [];

      for await (const part of parts) {
        const ext = path.extname(part.filename).toLowerCase();
        if (!ALLOWED_CHAT_EXTENSIONS.includes(ext)) {
          continue; // skip disallowed extensions
        }

        const buffer = await part.toBuffer();
        const safeName = part.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const destName = `${Date.now()}_${safeName}`;
        const destPath = path.join(uploadsDir, destName);
        fs.writeFileSync(destPath, buffer);
        uploaded.push({
          name: part.filename,
          path: `uploads/${destName}`,
          size: buffer.length,
          type: part.mimetype,
        });
      }

      if (uploaded.length === 0) { reply.code(400); return { error: "No files" }; }
      return { success: true, files: uploaded };
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Preview PDF / DOCX -- returns extracted HTML content
  fastify.get("/preview", async (request, reply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) { reply.code(400); return { error: "path required" }; }
      const resolved = validatePath(request.server.sandboxDir, filePath);
      if (!fs.existsSync(resolved)) { reply.code(404); return { error: "File not found" }; }

      const ext = path.extname(resolved).toLowerCase();

      if (ext === ".pdf") {
        const buffer = fs.readFileSync(resolved);
        const data = await pdfParse(buffer);
        // Return pages of text as HTML
        const html = data.text
          .split(/\f/) // form-feed = page break in pdf-parse
          .map((page: string) => page.trim())
          .filter((p: string) => p.length > 0)
          .map((page: string) => `<div class="pdf-page">${page.replace(/\n/g, "<br/>")}</div>`)
          .join('<hr class="page-break"/>');
        return { type: "pdf", pages: data.numpages, html };
      } else if (ext === ".docx" || ext === ".doc") {
        const buffer = fs.readFileSync(resolved);
        const result = await mammoth.convertToHtml({ buffer });
        return { type: "docx", html: result.value };
      } else if (ext === ".xlsx" || ext === ".xls") {
        const buffer = fs.readFileSync(resolved);
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetsHtml: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const html = XLSX.utils.sheet_to_html(sheet, { editable: false });
          sheetsHtml.push(`<h3 style="margin:12px 0 6px;font-size:14px;">${sheetName}</h3>${html}`);
        }
        return { type: "excel", sheets: workbook.SheetNames.length, html: sheetsHtml.join("") };
      } else if (ext === ".md") {
        const content = fs.readFileSync(resolved, "utf-8");
        return { type: "markdown", html: content };
      } else {
        reply.code(400); return { error: "Unsupported file type for preview" };
      }
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // Download
  fastify.get("/download", async (request, reply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) { reply.code(400); return { error: "path required" }; }
      const resolved = validatePath(request.server.sandboxDir, filePath);
      const fileName = path.basename(resolved);
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(createReadStream(resolved));
    } catch (err: any) {
      reply.code(403); return { error: err.message };
    }
  });
}
