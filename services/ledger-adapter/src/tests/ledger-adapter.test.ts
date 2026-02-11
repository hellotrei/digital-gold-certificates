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

test("records and returns event timeline", async () => {
  const app = await buildServer();
  try {
    const recordRes = await app.inject({
      method: "POST",
      url: "/events/record",
      payload: {
        event: {
          type: "ISSUED",
          certId: "DGC-TL-001",
          occurredAt: "2026-02-10T10:00:00.000Z",
          owner: "0xowner",
          amountGram: "1.0000",
          purity: "999.9",
        },
      },
    });
    assert.equal(recordRes.statusCode, 201);
    const recordBody = recordRes.json() as { eventHash: string };
    assert.equal(typeof recordBody.eventHash, "string");
    assert.equal(recordBody.eventHash.length > 0, true);

    const timelineRes = await app.inject({
      method: "GET",
      url: "/events/DGC-TL-001",
    });
    assert.equal(timelineRes.statusCode, 200);
    const timelineBody = timelineRes.json() as {
      certId: string;
      events: Array<{ type: string }>;
    };
    assert.equal(timelineBody.certId, "DGC-TL-001");
    assert.equal(timelineBody.events.length, 1);
    assert.equal(timelineBody.events[0].type, "ISSUED");
  } finally {
    await app.close();
  }
});

test("writes split event to parent and child timeline", async () => {
  const app = await buildServer();
  try {
    const recordRes = await app.inject({
      method: "POST",
      url: "/events/record",
      payload: {
        event: {
          type: "SPLIT",
          certId: "DGC-PARENT-1",
          parentCertId: "DGC-PARENT-1",
          childCertId: "DGC-CHILD-1",
          occurredAt: "2026-02-10T10:10:00.000Z",
          from: "0xalice",
          to: "0xbob",
          amountChildGram: "0.2500",
        },
      },
    });
    assert.equal(recordRes.statusCode, 201);

    const parentRes = await app.inject({
      method: "GET",
      url: "/events/DGC-PARENT-1",
    });
    const childRes = await app.inject({
      method: "GET",
      url: "/events/DGC-CHILD-1",
    });
    assert.equal(parentRes.statusCode, 200);
    assert.equal(childRes.statusCode, 200);
    const parentBody = parentRes.json() as { events: unknown[] };
    const childBody = childRes.json() as { events: unknown[] };
    assert.equal(parentBody.events.length, 1);
    assert.equal(childBody.events.length, 1);
  } finally {
    await app.close();
  }
});

test("returns configured false when chain is not set", async () => {
  const app = await buildServer({ chainWriter: null });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/chain/status",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { configured: boolean };
    assert.equal(body.configured, false);
  } finally {
    await app.close();
  }
});

test("records event with chain tx ref when chain writer exists", async () => {
  const app = await buildServer({
    chainWriter: {
      async recordEvent() {
        return { txHash: "0xabc123" };
      },
      async status() {
        return {
          configured: true,
          rpcUrl: "http://127.0.0.1:8545",
          registryAddress: "0x0000000000000000000000000000000000000001",
          latestBlock: 1,
          signerAddress: "0x0000000000000000000000000000000000000002",
        };
      },
    },
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/events/record",
      payload: {
        event: {
          type: "STATUS_CHANGED",
          certId: "DGC-CHAIN-001",
          occurredAt: "2026-02-11T00:00:00.000Z",
          status: "LOCKED",
        },
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { ledgerTxRef?: string };
    assert.equal(body.ledgerTxRef, "0xabc123");
  } finally {
    await app.close();
  }
});
