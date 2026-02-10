import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildServer } from "../server.js";

process.env.ISSUER_PRIVATE_KEY_HEX =
  "1f1e1d1c1b1a19181716151413121110ffeeddbbccaa99887766554433221100";

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "dgc-cert-service-"));
  return {
    dir,
    dbPath: join(dir, "certificates.db"),
  };
}

function createLedgerMockServer() {
  const timelines = new Map<string, Array<Record<string, unknown>>>();

  return createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/proofs/anchor") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          certId: string;
          payloadHash: string;
        };
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            proof: {
              certId: parsed.certId,
              payloadHash: parsed.payloadHash,
              proofHash: `proof-${parsed.certId}`,
              anchoredAt: "2026-02-10T00:00:00.000Z",
            },
          }),
        );
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/events/record") {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          event: Record<string, unknown> & {
            certId: string;
            type: string;
            childCertId?: string;
          };
        };

        const current = timelines.get(parsed.event.certId) || [];
        current.push(parsed.event);
        timelines.set(parsed.event.certId, current);
        if (parsed.event.type === "SPLIT" && parsed.event.childCertId) {
          const childCurrent = timelines.get(parsed.event.childCertId) || [];
          childCurrent.push(parsed.event);
          timelines.set(parsed.event.childCertId, childCurrent);
        }

        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            event: parsed.event,
            eventHash: "mock-event-hash",
          }),
        );
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/events/")) {
      const certId = decodeURIComponent(url.pathname.replace("/events/", ""));
      const events = timelines.get(certId) || [];
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ certId, events }));
      return;
    }

    res.statusCode = 404;
    res.end();
  });
}

test("issue, fetch, and verify certificate", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xabc123",
        amountGram: "1.2500",
        purity: "999.9",
        metadata: { batchRef: "BAR-LOT-2026-01" },
      },
    });

    assert.equal(issueRes.statusCode, 201);
    const issueBody = issueRes.json() as {
      certificate: { payload: { certId: string; status: string } };
    };
    assert.equal(issueBody.certificate.payload.status, "ACTIVE");

    const certId = issueBody.certificate.payload.certId;

    const getRes = await app.inject({
      method: "GET",
      url: `/certificates/${certId}`,
    });
    assert.equal(getRes.statusCode, 200);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/certificates/verify",
      payload: { certId },
    });
    assert.equal(verifyRes.statusCode, 200);
    const verifyBody = verifyRes.json() as {
      valid: boolean;
      hashMatches: boolean;
      signatureValid: boolean;
    };
    assert.equal(verifyBody.valid, true);
    assert.equal(verifyBody.hashMatches, true);
    assert.equal(verifyBody.signatureValid, true);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("serves OpenAPI document", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const res = await app.inject({
      method: "GET",
      url: "/openapi.json",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { openapi: string; paths: Record<string, unknown> };
    assert.equal(body.openapi, "3.0.3");
    assert.equal(typeof body.paths["/certificates/issue"], "object");
    assert.equal(typeof body.paths["/certificates/transfer"], "object");
    assert.equal(typeof body.paths["/certificates/split"], "object");
    assert.equal(typeof body.paths["/certificates/status"], "object");
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("verify fails when payload is tampered", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xdef456",
        amountGram: "2.0000",
        purity: "999.9",
      },
    });
    assert.equal(issueRes.statusCode, 201);
    const issueBody = issueRes.json() as {
      certificate: {
        payload: {
          certId: string;
          issuer: string;
          owner: string;
          amountGram: string;
          purity: string;
          issuedAt: string;
          status: "ACTIVE";
          metadata?: Record<string, unknown>;
        };
        payloadHash: string;
        signature: string;
      };
    };

    const tampered = {
      ...issueBody.certificate,
      payload: {
        ...issueBody.certificate.payload,
        amountGram: "3.0000",
      },
    };

    const verifyRes = await app.inject({
      method: "POST",
      url: "/certificates/verify",
      payload: { certificate: tampered },
    });

    assert.equal(verifyRes.statusCode, 200);
    const verifyBody = verifyRes.json() as {
      valid: boolean;
      hashMatches: boolean;
      signatureValid: boolean;
    };
    assert.equal(verifyBody.valid, false);
    assert.equal(verifyBody.hashMatches, false);
    assert.equal(verifyBody.signatureValid, false);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("persists certificate across server restart", async () => {
  const temp = createTempDbPath();
  const app1 = await buildServer({ dbPath: temp.dbPath });
  let certId = "";
  try {
    const issueRes = await app1.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xpersist001",
        amountGram: "5.5000",
        purity: "999.9",
      },
    });
    assert.equal(issueRes.statusCode, 201);
    const body = issueRes.json() as { certificate: { payload: { certId: string } } };
    certId = body.certificate.payload.certId;
  } finally {
    await app1.close();
  }

  const app2 = await buildServer({ dbPath: temp.dbPath });
  try {
    const getRes = await app2.inject({
      method: "GET",
      url: `/certificates/${certId}`,
    });
    assert.equal(getRes.statusCode, 200);
  } finally {
    await app2.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("anchors proof when ledger adapter URL is configured", async () => {
  const temp = createTempDbPath();
  const ledgerMock = createLedgerMockServer();

  await new Promise<void>((resolve) => ledgerMock.listen(0, "127.0.0.1", resolve));
  const address = ledgerMock.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const app = await buildServer({
    dbPath: temp.dbPath,
    ledgerAdapterUrl: `http://127.0.0.1:${port}`,
  });

  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xanchor",
        amountGram: "1.0000",
        purity: "999.9",
      },
    });

    assert.equal(issueRes.statusCode, 201);
    const issueBody = issueRes.json() as {
      proofAnchorStatus: string;
      eventWriteStatus: string;
      proof?: { proofHash: string };
    };
    assert.equal(issueBody.proofAnchorStatus, "ANCHORED");
    assert.equal(issueBody.eventWriteStatus, "RECORDED");
    assert.equal(typeof issueBody.proof?.proofHash, "string");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      ledgerMock.close((err) => (err ? reject(err) : resolve())),
    );
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("transfers ACTIVE certificate and records timeline event", async () => {
  const temp = createTempDbPath();
  const ledgerMock = createLedgerMockServer();
  await new Promise<void>((resolve) => ledgerMock.listen(0, "127.0.0.1", resolve));
  const address = ledgerMock.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const app = await buildServer({
    dbPath: temp.dbPath,
    ledgerAdapterUrl: `http://127.0.0.1:${port}`,
  });

  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xalice",
        amountGram: "2.0000",
        purity: "999.9",
      },
    });
    const certId = (
      issueRes.json() as { certificate: { payload: { certId: string } } }
    ).certificate.payload.certId;

    const transferRes = await app.inject({
      method: "POST",
      url: "/certificates/transfer",
      payload: {
        certId,
        toOwner: "0xbob",
        price: "1234.5000",
      },
    });
    assert.equal(transferRes.statusCode, 200);
    const transferBody = transferRes.json() as {
      certificate: { payload: { owner: string } };
      eventWriteStatus: string;
    };
    assert.equal(transferBody.certificate.payload.owner, "0xbob");
    assert.equal(transferBody.eventWriteStatus, "RECORDED");

    const timelineRes = await app.inject({
      method: "GET",
      url: `/certificates/${certId}/timeline`,
    });
    assert.equal(timelineRes.statusCode, 200);
    const timelineBody = timelineRes.json() as { events: Array<{ type: string }> };
    assert.equal(timelineBody.events.some((evt) => evt.type === "TRANSFER"), true);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      ledgerMock.close((err) => (err ? reject(err) : resolve())),
    );
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("split creates child certificate and updates parent amount", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xparent",
        amountGram: "3.0000",
        purity: "999.9",
      },
    });
    const parentCertId = (
      issueRes.json() as { certificate: { payload: { certId: string } } }
    ).certificate.payload.certId;

    const splitRes = await app.inject({
      method: "POST",
      url: "/certificates/split",
      payload: {
        parentCertId,
        toOwner: "0xchild",
        amountChildGram: "1.2500",
      },
    });

    assert.equal(splitRes.statusCode, 200);
    const splitBody = splitRes.json() as {
      parentCertificate: { payload: { amountGram: string; owner: string } };
      childCertificate: { payload: { amountGram: string; owner: string } };
    };
    assert.equal(splitBody.parentCertificate.payload.amountGram, "1.7500");
    assert.equal(splitBody.parentCertificate.payload.owner, "0xparent");
    assert.equal(splitBody.childCertificate.payload.amountGram, "1.2500");
    assert.equal(splitBody.childCertificate.payload.owner, "0xchild");
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("blocks transfer when certificate is not ACTIVE", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xholder",
        amountGram: "1.0000",
        purity: "999.9",
      },
    });
    const certId = (
      issueRes.json() as { certificate: { payload: { certId: string } } }
    ).certificate.payload.certId;

    const lockRes = await app.inject({
      method: "POST",
      url: "/certificates/status",
      payload: {
        certId,
        status: "LOCKED",
      },
    });
    assert.equal(lockRes.statusCode, 200);

    const transferRes = await app.inject({
      method: "POST",
      url: "/certificates/transfer",
      payload: {
        certId,
        toOwner: "0xnew",
      },
    });
    assert.equal(transferRes.statusCode, 409);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("rejects invalid status transition", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const issueRes = await app.inject({
      method: "POST",
      url: "/certificates/issue",
      payload: {
        owner: "0xholder2",
        amountGram: "1.0000",
        purity: "999.9",
      },
    });
    const certId = (
      issueRes.json() as { certificate: { payload: { certId: string } } }
    ).certificate.payload.certId;

    const redeemRes = await app.inject({
      method: "POST",
      url: "/certificates/status",
      payload: {
        certId,
        status: "REDEEMED",
      },
    });
    assert.equal(redeemRes.statusCode, 200);

    const backToActive = await app.inject({
      method: "POST",
      url: "/certificates/status",
      payload: {
        certId,
        status: "ACTIVE",
      },
    });
    assert.equal(backToActive.statusCode, 409);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
