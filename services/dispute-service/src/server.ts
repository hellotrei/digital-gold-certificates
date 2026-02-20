import Fastify from "fastify";

export async function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true, service: "dispute-service" }));

  return app;
}
