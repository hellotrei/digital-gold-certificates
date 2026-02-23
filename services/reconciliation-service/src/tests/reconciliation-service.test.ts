import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SignedCertificate } from "@dgc/shared";
import { buildServer } from "../server.js";

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "dgc-recon-service-"));
  return {
    dir,
    dbPath: join(dir, "reconciliation.db"),
  };
}

function certificate(certId: string, amountGram: string, status: SignedCertificate["payload"]["status"]): SignedCertificate {
  return {
    payload: {
      certId,
      issuer: "issuer-test",
      owner: "owner-test",
      amountGram,
      purity: "999.9",
      issuedAt: new Date().toISOString(),
      status,
    },
    payloadHash: `hash-${certId}`,
    signature: `sig-${certId}`,
  };
}

function createCertificateServiceMock(
  certificates: SignedCertificate[],
  expectedServiceToken?: string,
): Server {
  return createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/certificates") {
      if (expectedServiceToken) {
        const header = req.headers["x-service-token"];
        const actual = Array.isArray(header) ? header[0] : header;
        if (actual !== expectedServiceToken) {
          res.statusCode = 401;
          res.end();
          return;
        }
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ certificates }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

function createRiskStreamMock(received: unknown[], expectedServiceToken?: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/ingest/reconciliation-alert") {
      if (expectedServiceToken) {
        const header = req.headers["x-service-token"];
        const actual = Array.isArray(header) ? header[0] : header;
        if (actual !== expectedServiceToken) {
          res.statusCode = 401;
          res.end();
          return;
        }
      }
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ accepted: true, alertId: "mock-alert" }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const info = server.address();
  if (!info || typeof info === "string") {
    throw new Error("failed_to_resolve_server_port");
  }
  return `http://127.0.0.1:${info.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test("runs reconciliation, triggers freeze, and publishes alert", async () => {
  const temp = createTempDbPath();
  const postedAlerts: unknown[] = [];
  const certificateMock = createCertificateServiceMock([
    certificate("CERT-1", "1.5000", "ACTIVE"),
    certificate("CERT-2", "0.5000", "LOCKED"),
    certificate("CERT-3", "4.0000", "REDEEMED"),
  ]);
  const riskMock = createRiskStreamMock(postedAlerts);

  const certificateServiceUrl = await listen(certificateMock);
  const riskStreamUrl = await listen(riskMock);
  const app = await buildServer({
    dbPath: temp.dbPath,
    certificateServiceUrl,
    riskStreamUrl,
    custodyTotalGram: "1.0000",
    mismatchThresholdGram: "0.5000",
  });

  try {
    const runRes = await app.inject({
      method: "POST",
      url: "/reconcile/run",
      payload: {},
    });
    assert.equal(runRes.statusCode, 200);
    const runBody = runRes.json() as {
      run: {
        runId: string;
        freezeTriggered: boolean;
        outstandingTotalGram: string;
        mismatchGram: string;
        absMismatchGram: string;
        activeCertificates: number;
        lockedCertificates: number;
      };
      freezeState: { active: boolean };
    };
    assert.equal(runBody.run.freezeTriggered, true);
    assert.equal(runBody.run.outstandingTotalGram, "2.0000");
    assert.equal(runBody.run.mismatchGram, "1.0000");
    assert.equal(runBody.run.absMismatchGram, "1.0000");
    assert.equal(runBody.run.activeCertificates, 1);
    assert.equal(runBody.run.lockedCertificates, 1);
    assert.equal(runBody.freezeState.active, true);
    assert.equal(postedAlerts.length, 1);
    const posted = postedAlerts[0] as { runId: string; freezeTriggered: boolean };
    assert.equal(posted.runId, runBody.run.runId);
    assert.equal(posted.freezeTriggered, true);

    const latestRes = await app.inject({
      method: "GET",
      url: "/reconcile/latest",
    });
    assert.equal(latestRes.statusCode, 200);
    const latestBody = latestRes.json() as {
      run: { runId: string } | null;
      freezeState: { active: boolean };
    };
    assert.equal(latestBody.run?.runId, runBody.run.runId);
    assert.equal(latestBody.freezeState.active, true);

    const historyRes = await app.inject({
      method: "GET",
      url: "/reconcile/history?limit=1",
    });
    assert.equal(historyRes.statusCode, 200);
    const historyBody = historyRes.json() as { runs: Array<{ runId: string }> };
    assert.equal(historyBody.runs.length, 1);
    assert.equal(historyBody.runs[0]?.runId, runBody.run.runId);
  } finally {
    await app.close();
    await closeServer(certificateMock);
    await closeServer(riskMock);
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("supports inventory override and keeps freeze inactive below threshold", async () => {
  const temp = createTempDbPath();
  const certificateMock = createCertificateServiceMock([
    certificate("CERT-4", "1.0000", "ACTIVE"),
  ]);
  const certificateServiceUrl = await listen(certificateMock);
  const app = await buildServer({
    dbPath: temp.dbPath,
    certificateServiceUrl,
    custodyTotalGram: "0.0000",
    mismatchThresholdGram: "0.5000",
  });
  try {
    const runRes = await app.inject({
      method: "POST",
      url: "/reconcile/run",
      payload: { inventoryTotalGram: "1.1000" },
    });
    assert.equal(runRes.statusCode, 200);
    const runBody = runRes.json() as {
      run: { freezeTriggered: boolean; mismatchGram: string; absMismatchGram: string };
      freezeState: { active: boolean };
    };
    assert.equal(runBody.run.freezeTriggered, false);
    assert.equal(runBody.run.mismatchGram, "-0.1000");
    assert.equal(runBody.run.absMismatchGram, "0.1000");
    assert.equal(runBody.freezeState.active, false);
  } finally {
    await app.close();
    await closeServer(certificateMock);
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("returns 502 when certificate service is unavailable", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({
    dbPath: temp.dbPath,
    certificateServiceUrl: "http://127.0.0.1:65530",
  });
  try {
    const runRes = await app.inject({
      method: "POST",
      url: "/reconcile/run",
      payload: {},
    });
    assert.equal(runRes.statusCode, 502);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("manual unfreeze writes override audit history", async () => {
  const temp = createTempDbPath();
  const certificateMock = createCertificateServiceMock([
    certificate("CERT-5", "2.0000", "ACTIVE"),
  ]);
  const certificateServiceUrl = await listen(certificateMock);
  const app = await buildServer({
    dbPath: temp.dbPath,
    certificateServiceUrl,
    custodyTotalGram: "1.0000",
    mismatchThresholdGram: "0.5000",
  });

  try {
    const runRes = await app.inject({
      method: "POST",
      url: "/reconcile/run",
      payload: {},
    });
    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json().freezeState.active, true);

    const unfreezeRes = await app.inject({
      method: "POST",
      url: "/freeze/unfreeze",
      headers: {
        "x-governance-role": "ops_admin",
        "x-governance-actor": "ops-admin-1",
      },
      payload: {
        actor: "ops-admin-1",
        reason: "false_positive_reconciliation",
      },
    });
    assert.equal(unfreezeRes.statusCode, 200);
    const unfreezeBody = unfreezeRes.json() as {
      freezeState: { active: boolean; reason?: string };
      override: { action: string; actor: string; reason: string };
    };
    assert.equal(unfreezeBody.freezeState.active, false);
    assert.equal(unfreezeBody.override.action, "UNFREEZE");
    assert.equal(unfreezeBody.override.actor, "ops-admin-1");

    const overrideHistoryRes = await app.inject({
      method: "GET",
      url: "/freeze/overrides?limit=10",
    });
    assert.equal(overrideHistoryRes.statusCode, 200);
    const overrideHistoryBody = overrideHistoryRes.json() as {
      overrides: Array<{ action: string; actor: string; reason: string }>;
    };
    assert.equal(overrideHistoryBody.overrides.length, 1);
    assert.equal(overrideHistoryBody.overrides[0]?.action, "UNFREEZE");

    const unfreezeAgain = await app.inject({
      method: "POST",
      url: "/freeze/unfreeze",
      headers: {
        "x-governance-role": "ops_admin",
        "x-governance-actor": "ops-admin-1",
      },
      payload: {
        actor: "ops-admin-1",
        reason: "should_fail",
      },
    });
    assert.equal(unfreezeAgain.statusCode, 409);
  } finally {
    await app.close();
    await closeServer(certificateMock);
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("enforces service auth token on reconcile endpoints and outbound calls", async () => {
  const temp = createTempDbPath();
  const serviceToken = "svc-secret";
  const postedAlerts: unknown[] = [];
  const certificateMock = createCertificateServiceMock(
    [certificate("CERT-AUTH-1", "2.0000", "ACTIVE")],
    serviceToken,
  );
  const riskMock = createRiskStreamMock(postedAlerts, serviceToken);
  const certificateServiceUrl = await listen(certificateMock);
  const riskStreamUrl = await listen(riskMock);
  const app = await buildServer({
    dbPath: temp.dbPath,
    certificateServiceUrl,
    riskStreamUrl,
    custodyTotalGram: "1.0000",
    mismatchThresholdGram: "0.5000",
    serviceAuthToken: serviceToken,
  });

  try {
    const unauthorizedRun = await app.inject({
      method: "POST",
      url: "/reconcile/run",
      payload: {},
    });
    assert.equal(unauthorizedRun.statusCode, 401);

    const authorizedRun = await app.inject({
      method: "POST",
      url: "/reconcile/run",
      headers: { "x-service-token": serviceToken },
      payload: {},
    });
    assert.equal(authorizedRun.statusCode, 200);
    assert.equal(postedAlerts.length, 1);

    const latestUnauthorized = await app.inject({
      method: "GET",
      url: "/reconcile/latest",
    });
    assert.equal(latestUnauthorized.statusCode, 401);

    const latestAuthorized = await app.inject({
      method: "GET",
      url: "/reconcile/latest",
      headers: { "x-service-token": serviceToken },
    });
    assert.equal(latestAuthorized.statusCode, 200);

    const unauthorizedUnfreeze = await app.inject({
      method: "POST",
      url: "/freeze/unfreeze",
      headers: {
        "x-service-token": serviceToken,
        "x-governance-role": "viewer",
        "x-governance-actor": "ops-admin-1",
      },
      payload: {
        actor: "ops-admin-1",
        reason: "unauthorized_role_test",
      },
    });
    assert.equal(unauthorizedUnfreeze.statusCode, 403);
  } finally {
    await app.close();
    await closeServer(certificateMock);
    await closeServer(riskMock);
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
