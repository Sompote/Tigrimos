import { FastifyInstance } from "fastify";
import { spawn, ChildProcess } from "child_process";
import { Server } from "socket.io";

let activeShell: ChildProcess | null = null;

export function setupTerminalSocket(io: Server) {
  io.on("connection", (socket) => {
    socket.on("terminal:start", () => {
      // Kill existing shell if any
      if (activeShell && !activeShell.killed) {
        activeShell.kill();
      }

      // Use sudo bash so users can install packages, manage services, etc.
      // The tigris user has NOPASSWD sudo configured by cloud-init.
      const useRoot = process.getuid?.() !== 0;
      const cmd = useRoot ? "sudo" : "/bin/bash";
      const args = useRoot ? ["/bin/bash", "-l"] : ["-l"];

      const shell = spawn(cmd, args, {
        cwd: process.env.SANDBOX_DIR || process.cwd(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLUMNS: "120",
          LINES: "30",
          HOME: useRoot ? "/root" : (process.env.HOME || "/home/tigris"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      activeShell = shell;

      socket.emit("terminal:started");

      shell.stdout?.on("data", (data: Buffer) => {
        socket.emit("terminal:output", data.toString());
      });

      shell.stderr?.on("data", (data: Buffer) => {
        socket.emit("terminal:output", data.toString());
      });

      shell.on("close", (code) => {
        socket.emit("terminal:exit", { code });
        activeShell = null;
      });

      shell.on("error", (err) => {
        socket.emit("terminal:output", `\r\nError: ${err.message}\r\n`);
      });

      socket.on("terminal:input", (data: string) => {
        if (shell && !shell.killed) {
          shell.stdin?.write(data);
        }
      });

      socket.on("terminal:resize", (size: { cols: number; rows: number }) => {
        // Update env for new processes
        if (shell && !shell.killed) {
          process.env.COLUMNS = String(size.cols);
          process.env.LINES = String(size.rows);
        }
      });

      socket.on("disconnect", () => {
        if (shell && !shell.killed) {
          shell.kill();
          activeShell = null;
        }
      });
    });

    socket.on("terminal:stop", () => {
      if (activeShell && !activeShell.killed) {
        activeShell.kill();
        activeShell = null;
      }
    });
  });
}

export async function terminalRoutes(fastify: FastifyInstance) {
  // Simple exec endpoint for one-off commands
  fastify.post<{ Body: { command: string } }>("/exec", async (request) => {
    const { command } = request.body;
    if (!command) return { error: "No command provided" };

    return new Promise((resolve) => {
      const useRoot = process.getuid?.() !== 0;
      const proc = useRoot
        ? spawn("sudo", ["/bin/bash", "-c", command], {
            cwd: process.env.SANDBOX_DIR || process.cwd(),
            env: { ...process.env, TERM: "dumb" },
            timeout: 30000,
          })
        : spawn("/bin/bash", ["-c", command], {
            cwd: process.env.SANDBOX_DIR || process.cwd(),
            env: { ...process.env, TERM: "dumb" },
            timeout: 30000,
          });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code });
      });
      proc.on("error", (err) => {
        resolve({ error: err.message, exitCode: 1 });
      });
    });
  });
}
