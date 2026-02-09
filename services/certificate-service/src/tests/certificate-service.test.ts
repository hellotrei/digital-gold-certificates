import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../server.js";

process.env.ISSUER_PRIVATE_KEY_HEX =
  "1f1e1d1c1b1a19181716151413121110ffeeddbbccaa99887766554433221100";

test("issue, fetch, and verify certificate", async () => {
  const app = await buildServer();
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
  }
});

test("verify fails when payload is tampered", async () => {
  const app = await buildServer();
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
  }
});
