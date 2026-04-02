import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { getSettings } from "./data";

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFiles: string[];
}

export async function runPython(
  code: string,
  sandboxDir: string,
  timeout: number = 30000,
  projectOutputDir?: string
): Promise<PythonResult> {
  const settings = await getSettings();
  return new Promise((resolve) => {
    const pythonPath = settings.pythonPath || "python3";
    const scriptPath = path.join(sandboxDir, `_run_${Date.now()}.py`);

    // Use project working folder if provided, otherwise fall back to output_file/
    const outputDir = projectOutputDir || path.join(sandboxDir, "output_file");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const wrappedCode = `
import os, sys, urllib.parse, urllib.request, json

# Set default User-Agent for web requests
opener = urllib.request.build_opener()
opener.addheaders = [('User-Agent', 'TigerCowork/1.0 (Python; Web Search)')]
urllib.request.install_opener(opener)

# Configure matplotlib for non-interactive backend (save to file, not show)
try:
    import matplotlib
    matplotlib.use('Agg')
except ImportError:
    pass

# PROJECT_DIR points to the project root (or project working folder if in project context)
PROJECT_DIR = ${JSON.stringify(projectOutputDir || sandboxDir)}
os.chdir(${JSON.stringify(outputDir)})
${code}
`;

    fs.writeFileSync(scriptPath, wrappedCode);

    // Record start time to detect files created during this execution
    const startTime = Date.now();

    const proc = spawn(pythonPath, [scriptPath], {
      cwd: sandboxDir,
      timeout,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (exitCode) => {
      // Clean up temp script
      try { fs.unlinkSync(scriptPath); } catch {}

      // Detect files created/modified during this execution in the output directory
      const outputFiles: string[] = [];
      const outputExts = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp", ".txt", ".md"];
      const scanDirs = [outputDir];
      try {
        for (const dir of scanDirs) {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir);
          for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            if (outputExts.includes(ext)) {
              const fullPath = path.join(dir, f);
              const stat = fs.statSync(fullPath);
              // Include files modified after script started (not a fixed window)
              if (stat.mtimeMs >= startTime - 1000) {
                // Store relative path from sandboxDir
                const relPath = path.relative(sandboxDir, fullPath);
                outputFiles.push(relPath);
              }
            }
          }
        }
      } catch {}

      resolve({ stdout, stderr, exitCode: exitCode ?? 1, outputFiles });
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(scriptPath); } catch {}
      resolve({ stdout: "", stderr: err.message, exitCode: 1, outputFiles: [] });
    });
  });
}
