import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { getTasks, saveTasks } from "../services/data";
import { scheduleTask, stopTask } from "../services/scheduler";
import { getActiveTasks, killActiveTask } from "../services/socket";

export async function tasksRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    return await getTasks();
  });

  fastify.get("/active", async (request, reply) => {
    return getActiveTasks();
  });

  fastify.post("/active/:id/kill", async (request, reply) => {
    const killed = killActiveTask((request.params as any).id);
    if (!killed) { reply.code(404); return { error: "Task not found or already completed" }; }
    return { success: true };
  });

  fastify.post("/", async (request, reply) => {
    const tasks = await getTasks();
    const body = request.body as any;
    const task = {
      id: uuid(),
      name: body.name || "Untitled Task",
      cron: body.cron || "0 * * * *",
      command: body.command || "",
      enabled: body.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    await saveTasks(tasks);
    if (task.enabled) scheduleTask(task);
    return task;
  });

  fastify.patch("/:id", async (request, reply) => {
    const tasks = await getTasks();
    const idx = tasks.findIndex((t) => t.id === (request.params as any).id);
    if (idx < 0) { reply.code(404); return { error: "Not found" }; }

    Object.assign(tasks[idx], request.body as any);
    await saveTasks(tasks);

    if (tasks[idx].enabled) {
      scheduleTask(tasks[idx]);
    } else {
      stopTask(tasks[idx].id);
    }
    return tasks[idx];
  });

  fastify.delete("/:id", async (request, reply) => {
    let tasks = await getTasks();
    stopTask((request.params as any).id);
    tasks = tasks.filter((t) => t.id !== (request.params as any).id);
    await saveTasks(tasks);
    return { success: true };
  });
}
