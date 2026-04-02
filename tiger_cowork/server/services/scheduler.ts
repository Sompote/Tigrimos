import cron from "node-cron";
import { exec } from "child_process";
import { getTasks, saveTasks, ScheduledTask } from "./data";

const activeJobs = new Map<string, cron.ScheduledTask>();

export async function initScheduler(): Promise<void> {
  const tasks = await getTasks();
  tasks.filter((t) => t.enabled).forEach((t) => scheduleTask(t));
}

export function scheduleTask(task: ScheduledTask): boolean {
  if (!cron.validate(task.cron)) return false;

  // Stop existing job if any
  stopTask(task.id);

  const job = cron.schedule(task.cron, () => {
    exec(task.command, { timeout: 60000 }, async (err, stdout, stderr) => {
      const tasks = await getTasks();
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) {
        tasks[idx].lastRun = new Date().toISOString();
        tasks[idx].lastResult = err ? `Error: ${stderr}` : stdout.slice(0, 1000);
        await saveTasks(tasks);
      }
    });
  });

  activeJobs.set(task.id, job);
  return true;
}

export function stopTask(id: string): void {
  const job = activeJobs.get(id);
  if (job) {
    job.stop();
    activeJobs.delete(id);
  }
}

export function stopAllTasks(): void {
  activeJobs.forEach((job) => job.stop());
  activeJobs.clear();
}

