import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildServer } from "../server.js";

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "dgc-dispute-service-"));
  return {
    dir,
    dbPath: join(dir, "dispute.db"),
  };
}

test("health endpoint is available", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
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
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("opens, assigns, resolves, gets and lists disputes", async () => {
  const temp = createTempDbPath();
  const app = await buildServer({ dbPath: temp.dbPath });
  try {
    const openRes = await app.inject({
      method: "POST",
      url: "/disputes/open",
      payload: {
        listingId: "LST-001",
        certId: "DGC-001",
        openedBy: "buyer-1",
        reason: "delayed_delivery",
        evidence: { screenshot: "ipfs://sample-proof" },
      },
    });
    assert.equal(openRes.statusCode, 201);
    const openBody = openRes.json() as {
      dispute: { disputeId: string; status: string; listingId: string };
    };
    assert.equal(openBody.dispute.status, "OPEN");
    assert.equal(openBody.dispute.listingId, "LST-001");
    const disputeId = openBody.dispute.disputeId;

    const assignRes = await app.inject({
      method: "POST",
      url: `/disputes/${encodeURIComponent(disputeId)}/assign`,
      payload: { assignee: "ops-analyst-1" },
    });
    assert.equal(assignRes.statusCode, 200);
    const assignBody = assignRes.json() as {
      dispute: { status: string; assignedTo?: string };
    };
    assert.equal(assignBody.dispute.status, "ASSIGNED");
    assert.equal(assignBody.dispute.assignedTo, "ops-analyst-1");

    const resolveRes = await app.inject({
      method: "POST",
      url: `/disputes/${encodeURIComponent(disputeId)}/resolve`,
      payload: {
        resolvedBy: "ops-lead-1",
        resolution: "REFUND_BUYER",
        resolutionNotes: "evidence_verified",
      },
    });
    assert.equal(resolveRes.statusCode, 200);
    const resolveBody = resolveRes.json() as {
      dispute: { status: string; resolution?: string };
    };
    assert.equal(resolveBody.dispute.status, "RESOLVED");
    assert.equal(resolveBody.dispute.resolution, "REFUND_BUYER");

    const getRes = await app.inject({
      method: "GET",
      url: `/disputes/${encodeURIComponent(disputeId)}`,
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().dispute.disputeId, disputeId);

    const listResolvedRes = await app.inject({
      method: "GET",
      url: "/disputes?status=RESOLVED",
    });
    assert.equal(listResolvedRes.statusCode, 200);
    const listResolvedBody = listResolvedRes.json() as {
      disputes: Array<{ disputeId: string }>;
    };
    assert.equal(listResolvedBody.disputes.length, 1);
    assert.equal(listResolvedBody.disputes[0]?.disputeId, disputeId);

    const assignResolvedRes = await app.inject({
      method: "POST",
      url: `/disputes/${encodeURIComponent(disputeId)}/assign`,
      payload: { assignee: "ops-analyst-2" },
    });
    assert.equal(assignResolvedRes.statusCode, 409);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
