import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../server.js";

test("health endpoint is available", async () => {
  const app = await buildServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; service: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "dispute-service");
  } finally {
    await app.close();
  }
});
