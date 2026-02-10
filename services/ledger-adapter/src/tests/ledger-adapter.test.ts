import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../server.js";

test("anchors proof and retrieves by certId", async () => {
  const app = await buildServer();
  try {
    const anchorRes = await app.inject({
      method: "POST",
      url: "/proofs/anchor",
      payload: {
        certId: "DGC-TEST-001",
        payloadHash: "abc123",
        occurredAt: "2026-02-10T00:00:00.000Z",
      },
    });
    assert.equal(anchorRes.statusCode, 201);
    const anchorBody = anchorRes.json() as { proof: { certId: string; proofHash: string } };
    assert.equal(anchorBody.proof.certId, "DGC-TEST-001");
    assert.equal(typeof anchorBody.proof.proofHash, "string");
    assert.equal(anchorBody.proof.proofHash.length > 0, true);

    const getRes = await app.inject({
      method: "GET",
      url: "/proofs/DGC-TEST-001",
    });
    assert.equal(getRes.statusCode, 200);
    const getBody = getRes.json() as { proof: { certId: string } };
    assert.equal(getBody.proof.certId, "DGC-TEST-001");
  } finally {
    await app.close();
  }
});

test("rejects invalid anchor payload", async () => {
  const app = await buildServer();
  try {
    const anchorRes = await app.inject({
      method: "POST",
      url: "/proofs/anchor",
      payload: {
        certId: "",
        payloadHash: "abc123",
      },
    });
    assert.equal(anchorRes.statusCode, 400);
  } finally {
    await app.close();
  }
});
