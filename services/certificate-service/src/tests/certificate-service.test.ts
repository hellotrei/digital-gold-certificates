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
  const ledgerMock = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/proofs/anchor") {
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
              proofHash: "mock-proof-hash",
              anchoredAt: "2026-02-10T00:00:00.000Z",
            },
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

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
      proof?: { proofHash: string };
    };
    assert.equal(issueBody.proofAnchorStatus, "ANCHORED");
    assert.equal(issueBody.proof?.proofHash, "mock-proof-hash");
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      ledgerMock.close((err) => (err ? reject(err) : resolve())),
    );
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
