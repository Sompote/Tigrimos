import { FastifyInstance } from "fastify";
import { runPython } from "../services/python";
import { getSettings } from "../services/data";
import path from "path";

export async function pythonRoutes(fastify: FastifyInstance) {
  fastify.post("/run", async (request, reply) => {
    const { code } = request.body as any;
    if (!code) { reply.code(400); return { error: "code required" }; }

    const settings = await getSettings();
    const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
    const result = await runPython(code, sandboxDir);
    return result;
  });
}
