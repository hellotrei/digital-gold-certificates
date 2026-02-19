import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LedgerEvent, ListingAuditEvent } from "@dgc/shared";
import { buildServer } from "../server.js";

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "dgc-risk-stream-"));
  return {
    dir,
    dbPath: join(dir, "risk.db"),
  };
}

function nowMinusMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

test("builds certificate risk from transfer velocity and wash loop", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const events: LedgerEvent[] = [
      {
        type: "TRANSFER",
        certId: "DGC-RISK-CERT-1",
        occurredAt: nowMinusMs(60 * 60 * 1000),
        from: "0xA",
        to: "0xB",
        amountGram: "1.0000",
      },
      {
        type: "TRANSFER",
        certId: "DGC-RISK-CERT-1",
        occurredAt: nowMinusMs(40 * 60 * 1000),
        from: "0xB",
        to: "0xA",
        amountGram: "1.0000",
      },
      {
        type: "TRANSFER",
        certId: "DGC-RISK-CERT-1",
        occurredAt: nowMinusMs(20 * 60 * 1000),
        from: "0xA",
        to: "0xC",
        amountGram: "1.0000",
      },
    ];

    for (const event of events) {
      const ingest = await app.inject({
        method: "POST",
        url: "/ingest/ledger-event",
        payload: { event },
      });
      assert.equal(ingest.statusCode, 202);
    }

    const riskRes = await app.inject({
      method: "GET",
      url: "/risk/certificates/DGC-RISK-CERT-1",
    });
    assert.equal(riskRes.statusCode, 200);
    const body = riskRes.json() as {
      profile: {
        score: number;
        reasons: Array<{ code: string }>;
        level: string;
      };
    };
    assert.ok(body.profile.score >= 50);
    assert.deepEqual(
      body.profile.reasons.map((reason) => reason.code).sort(),
      ["TRANSFER_VELOCITY_ELEVATED", "WASH_LOOP_PATTERN"].sort(),
    );
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("builds listing risk from lock-cancel pattern and timeout signal", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const events: ListingAuditEvent[] = [
      {
        eventId: "AUD-1",
        listingId: "LST-RISK-1",
        type: "CREATED",
        actor: "seller-1",
        occurredAt: nowMinusMs(60 * 60 * 1000),
      },
      {
        eventId: "AUD-2",
        listingId: "LST-RISK-1",
        type: "LOCKED",
        actor: "buyer-1",
        occurredAt: nowMinusMs(40 * 60 * 1000),
      },
      {
        eventId: "AUD-3",
        listingId: "LST-RISK-1",
        type: "CANCELLED",
        actor: "buyer-1",
        occurredAt: nowMinusMs(20 * 60 * 1000),
        details: { reason: "buyer_timeout" },
      },
    ];

    for (const event of events) {
      const ingest = await app.inject({
        method: "POST",
        url: "/ingest/listing-audit-event",
        payload: {
          event,
          listing: { listingId: "LST-RISK-1", certId: "DGC-RISK-CERT-2" },
        },
      });
      assert.equal(ingest.statusCode, 202);
    }

    const listingRisk = await app.inject({
      method: "GET",
      url: "/risk/listings/LST-RISK-1",
    });
    assert.equal(listingRisk.statusCode, 200);
    const body = listingRisk.json() as {
      profile: { score: number; reasons: Array<{ code: string }> };
    };
    assert.ok(body.profile.score >= 40);
    assert.ok(body.profile.reasons.some((reason) => reason.code === "LOCK_CANCEL_PATTERN"));
    assert.ok(body.profile.reasons.some((reason) => reason.code === "BUYER_TIMEOUT_SIGNAL"));
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("persists risk profiles across restart", async () => {
  const temp = createTempDbPath();
  const app1 = await buildServer({ dbPath: temp.dbPath });
  try {
    const ingest = await app1.inject({
      method: "POST",
      url: "/ingest/ledger-event",
      payload: {
        event: {
          type: "TRANSFER",
          certId: "DGC-RISK-CERT-3",
          occurredAt: nowMinusMs(10 * 60 * 1000),
          from: "0x1",
          to: "0x2",
          amountGram: "1.0000",
        } satisfies LedgerEvent,
      },
    });
    assert.equal(ingest.statusCode, 202);
  } finally {
    await app1.close();
  }

  const app2 = await buildServer({ dbPath: temp.dbPath });
  try {
    const riskRes = await app2.inject({
      method: "GET",
      url: "/risk/certificates/DGC-RISK-CERT-3",
    });
    assert.equal(riskRes.statusCode, 200);
  } finally {
    await app2.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("summarizes risk profiles and emits alerts when threshold crossed", async () => {
  const temp = createTempDbPath();
  const previousThreshold = process.env.RISK_ALERT_THRESHOLD;
  process.env.RISK_ALERT_THRESHOLD = "10";
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const events: LedgerEvent[] = [
      {
        type: "TRANSFER",
        certId: "DGC-RISK-CERT-4",
        occurredAt: nowMinusMs(50 * 60 * 1000),
        from: "0x1",
        to: "0x2",
        amountGram: "1.0000",
      },
      {
        type: "TRANSFER",
        certId: "DGC-RISK-CERT-4",
        occurredAt: nowMinusMs(40 * 60 * 1000),
        from: "0x2",
        to: "0x3",
        amountGram: "1.0000",
      },
      {
        type: "TRANSFER",
        certId: "DGC-RISK-CERT-4",
        occurredAt: nowMinusMs(30 * 60 * 1000),
        from: "0x3",
        to: "0x4",
        amountGram: "1.0000",
      },
    ];

    for (const event of events) {
      const ingest = await app.inject({
        method: "POST",
        url: "/ingest/ledger-event",
        payload: { event },
      });
      assert.equal(ingest.statusCode, 202);
    }

    const summaryRes = await app.inject({
      method: "GET",
      url: "/risk/summary?limit=5",
    });
    assert.equal(summaryRes.statusCode, 200);
    const summaryBody = summaryRes.json() as {
      topCertificates: Array<{ certId: string; score: number }>;
      topListings: Array<{ listingId: string }>;
    };
    assert.equal(summaryBody.topCertificates.length, 1);
    assert.equal(summaryBody.topCertificates[0]?.certId, "DGC-RISK-CERT-4");
    assert.ok(summaryBody.topCertificates[0]?.score >= 25);
    assert.equal(summaryBody.topListings.length, 0);

    const alertsRes = await app.inject({
      method: "GET",
      url: "/risk/alerts?limit=5",
    });
    assert.equal(alertsRes.statusCode, 200);
    const alertsBody = alertsRes.json() as {
      alerts: Array<{ targetType: string; targetId: string; score: number }>;
    };
    assert.equal(alertsBody.alerts.length, 1);
    assert.equal(alertsBody.alerts[0]?.targetType, "CERTIFICATE");
    assert.equal(alertsBody.alerts[0]?.targetId, "DGC-RISK-CERT-4");
    assert.ok(alertsBody.alerts[0]?.score >= 25);
  } finally {
    await app.close();
    if (previousThreshold === undefined) {
      delete process.env.RISK_ALERT_THRESHOLD;
    } else {
      process.env.RISK_ALERT_THRESHOLD = previousThreshold;
    }
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("ingests reconciliation alerts into risk alerts feed", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const now = new Date().toISOString();
    const ingest = await app.inject({
      method: "POST",
      url: "/ingest/reconciliation-alert",
      payload: {
        runId: "RECON-RUN-1",
        mismatchGram: "1.2500",
        absMismatchGram: "1.2500",
        thresholdGram: "0.5000",
        freezeTriggered: true,
        createdAt: now,
      },
    });
    assert.equal(ingest.statusCode, 202);
    const ingestBody = ingest.json() as { accepted: true; alertId: string };
    assert.equal(ingestBody.accepted, true);
    assert.equal(ingestBody.alertId, "ALERT-RECON-RECON-RUN-1");

    const alerts = await app.inject({
      method: "GET",
      url: "/risk/alerts?limit=10",
    });
    assert.equal(alerts.statusCode, 200);
    const alertsBody = alerts.json() as {
      alerts: Array<{ targetType: string; targetId: string; score: number }>;
    };
    assert.equal(alertsBody.alerts.length, 1);
    assert.equal(alertsBody.alerts[0]?.targetType, "RECONCILIATION");
    assert.equal(alertsBody.alerts[0]?.targetId, "RECON-RUN-1");
    assert.ok((alertsBody.alerts[0]?.score || 0) > 0);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("returns 404 when risk profile does not exist", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const certRes = await app.inject({
      method: "GET",
      url: "/risk/certificates/DGC-NOT-FOUND",
    });
    assert.equal(certRes.statusCode, 404);

    const listingRes = await app.inject({
      method: "GET",
      url: "/risk/listings/LST-NOT-FOUND",
    });
    assert.equal(listingRes.statusCode, 404);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
