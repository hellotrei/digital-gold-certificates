import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CertificateStatus,
  ChangeCertificateStatusRequest,
  ChangeCertificateStatusResponse,
  OpenDisputeRequest,
  OpenDisputeResponse,
  ListListingsResponse,
  ListingAuditEvent,
  MarketplaceListing,
  SignedCertificate,
  TransferCertificateRequest,
  TransferCertificateResponse,
} from "@dgc/shared";
import {
  buildServer,
  type CertificateClient,
  type DisputeClient,
  type ReconciliationClient,
} from "../server.js";

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "dgc-marketplace-service-"));
  return {
    dir,
    dbPath: join(dir, "marketplace.db"),
  };
}

function makeCertificate(
  certId: string,
  owner: string,
  status: CertificateStatus = "ACTIVE",
): SignedCertificate {
  return {
    payload: {
      certId,
      issuer: "issuer-public-key",
      owner,
      amountGram: "1.0000",
      purity: "999.9",
      issuedAt: "2026-02-12T00:00:00.000Z",
      status,
    },
    payloadHash: "hash",
    signature: "signature",
  };
}

function createCertificateClient(
  overrides: Partial<CertificateClient> = {},
): CertificateClient {
  return {
    async getCertificate(certId: string) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-default") },
      };
    },
    async changeStatus(request: ChangeCertificateStatusRequest) {
      const response: ChangeCertificateStatusResponse = {
        certificate: makeCertificate(request.certId, "seller-default", request.status),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
    async transfer(request: TransferCertificateRequest) {
      const response: TransferCertificateResponse = {
        certificate: makeCertificate(request.certId, request.toOwner, "ACTIVE"),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
    ...overrides,
  };
}

function createReconciliationClient(
  freezeActive: () => boolean,
): ReconciliationClient {
  return {
    async getLatest() {
      const active = freezeActive();
      return {
        ok: true,
        status: 200,
        data: {
          run: null,
          freezeState: {
            active,
            reason: active ? "Reconciliation threshold breached" : undefined,
            updatedAt: "2026-02-19T00:00:00.000Z",
          },
        },
      };
    },
  };
}

function createDisputeClient(
  overrides: Partial<DisputeClient> = {},
): DisputeClient {
  return {
    async openDispute(request: OpenDisputeRequest) {
      const now = new Date().toISOString();
      const response: OpenDisputeResponse = {
        dispute: {
          disputeId: "DSP-MOCK-001",
          listingId: request.listingId,
          certId: request.certId,
          status: "OPEN",
          openedBy: request.openedBy,
          reason: request.reason,
          evidence: request.evidence,
          openedAt: now,
        },
      };
      return { ok: true, status: 201, data: response };
    },
    ...overrides,
  };
}

test("creates listing, lists by filter, and exposes audit trail", async () => {
  const temp = createTempDbPath();
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-A") },
      };
    },
  });

  const app = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-001", seller: "seller-A", askPrice: "1000.0000" },
    });
    assert.equal(createRes.statusCode, 201);

    const listing = (createRes.json() as { listing: MarketplaceListing }).listing;

    const lockRes = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-1" },
      payload: { listingId: listing.listingId, buyer: "buyer-A" },
    });
    assert.equal(lockRes.statusCode, 200);

    const listRes = await app.inject({
      method: "GET",
      url: "/listings?status=LOCKED",
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json() as ListListingsResponse;
    assert.equal(listBody.listings.length, 1);
    assert.equal(listBody.listings[0].listingId, listing.listingId);

    const auditRes = await app.inject({
      method: "GET",
      url: `/listings/${encodeURIComponent(listing.listingId)}/audit`,
    });
    assert.equal(auditRes.statusCode, 200);
    const auditBody = auditRes.json() as { events: ListingAuditEvent[] };
    assert.deepEqual(
      auditBody.events.map((event) => event.type),
      ["CREATED", "LOCKED"],
    );
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("rejects listing when seller does not match current owner", async () => {
  const temp = createTempDbPath();
  const client = createCertificateClient({
    async getCertificate() {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate("DGC-LIST-002", "owner-real") },
      };
    },
  });

  const app = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-002", seller: "owner-fake", askPrice: "500.0000" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "owner_mismatch");
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("requires idempotency key for lock/settle/cancel", async () => {
  const temp = createTempDbPath();
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-B") },
      };
    },
  });

  const app = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-003", seller: "seller-B", askPrice: "1300.0000" },
    });
    const listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;

    const lockRes = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      payload: { listingId, buyer: "buyer-B" },
    });
    assert.equal(lockRes.statusCode, 400);
    assert.equal(lockRes.json().error, "missing_idempotency_key");

    await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-3" },
      payload: { listingId, buyer: "buyer-B" },
    });

    const settleRes = await app.inject({
      method: "POST",
      url: "/escrow/settle",
      payload: { listingId, buyer: "buyer-B" },
    });
    assert.equal(settleRes.statusCode, 400);

    const cancelRes = await app.inject({
      method: "POST",
      url: "/escrow/cancel",
      payload: { listingId },
    });
    assert.equal(cancelRes.statusCode, 400);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("replays lock response on duplicate idempotency key", async () => {
  const temp = createTempDbPath();
  const statusCalls: ChangeCertificateStatusRequest[] = [];
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-C") },
      };
    },
    async changeStatus(request) {
      statusCalls.push(request);
      const response: ChangeCertificateStatusResponse = {
        certificate: makeCertificate(request.certId, "seller-C", request.status),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
  });

  const app = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-004", seller: "seller-C", askPrice: "1400.0000" },
    });
    const listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;

    const first = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-4" },
      payload: { listingId, buyer: "buyer-C" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-4" },
      payload: { listingId, buyer: "buyer-C" },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(first.json(), second.json());
    assert.deepEqual(statusCalls, [{ certId: "DGC-LIST-004", status: "LOCKED" }]);

    const conflict = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-4" },
      payload: { listingId, buyer: "buyer-C-other" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, "idempotency_key_reuse_conflict");
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("settles and cancels with expected certificate transitions", async () => {
  const temp = createTempDbPath();
  const ops: string[] = [];
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-D") },
      };
    },
    async changeStatus(request) {
      ops.push(`status:${request.status}`);
      const response: ChangeCertificateStatusResponse = {
        certificate: makeCertificate(request.certId, "seller-D", request.status),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
    async transfer(request) {
      ops.push("transfer");
      const response: TransferCertificateResponse = {
        certificate: makeCertificate(request.certId, request.toOwner, "ACTIVE"),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
  });

  const app = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  try {
    const createOne = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-005", seller: "seller-D", askPrice: "1500.0000" },
    });
    const listingOne = (createOne.json() as { listing: MarketplaceListing }).listing.listingId;

    await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-5" },
      payload: { listingId: listingOne, buyer: "buyer-D" },
    });

    const settleRes = await app.inject({
      method: "POST",
      url: "/escrow/settle",
      headers: { "idempotency-key": "settle-5" },
      payload: { listingId: listingOne, buyer: "buyer-D", settledPrice: "1499.0000" },
    });
    assert.equal(settleRes.statusCode, 200);
    assert.equal(settleRes.json().listing.status, "SETTLED");

    const createTwo = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-006", seller: "seller-D", askPrice: "1550.0000" },
    });
    const listingTwo = (createTwo.json() as { listing: MarketplaceListing }).listing.listingId;

    await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "lock-6" },
      payload: { listingId: listingTwo, buyer: "buyer-E" },
    });

    const cancelRes = await app.inject({
      method: "POST",
      url: "/escrow/cancel",
      headers: { "idempotency-key": "cancel-6" },
      payload: { listingId: listingTwo, reason: "buyer_timeout" },
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.json().listing.status, "CANCELLED");

    assert.deepEqual(ops, [
      "status:LOCKED",
      "status:ACTIVE",
      "transfer",
      "status:LOCKED",
      "status:ACTIVE",
    ]);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("keeps listing data after server restart", async () => {
  const temp = createTempDbPath();
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-restart") },
      };
    },
  });

  const app1 = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  let listingId = "";
  try {
    const createRes = await app1.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-007", seller: "seller-restart", askPrice: "2000.0000" },
    });
    listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;
  } finally {
    await app1.close();
  }

  const app2 = await buildServer({ certificateClient: client, dbPath: temp.dbPath });
  try {
    const getRes = await app2.inject({
      method: "GET",
      url: `/listings/${encodeURIComponent(listingId)}`,
    });
    assert.equal(getRes.statusCode, 200);
    const getBody = getRes.json() as { listing: MarketplaceListing };
    assert.equal(getBody.listing.listingId, listingId);
    assert.equal(getBody.listing.status, "OPEN");
  } finally {
    await app2.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("enforces freeze flag for create/lock/settle while allowing cancel", async () => {
  const temp = createTempDbPath();
  let frozen = false;
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-freeze") },
      };
    },
  });
  const reconciliationClient = createReconciliationClient(() => frozen);

  const app = await buildServer({
    certificateClient: client,
    reconciliationClient,
    dbPath: temp.dbPath,
  });
  try {
    const createOpen = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-FRZ-OPEN", seller: "seller-freeze", askPrice: "1000.0000" },
    });
    assert.equal(createOpen.statusCode, 201);
    const openListingId = (createOpen.json() as { listing: MarketplaceListing }).listing.listingId;

    const createLocked = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-FRZ-LOCKED", seller: "seller-freeze", askPrice: "1100.0000" },
    });
    assert.equal(createLocked.statusCode, 201);
    const lockedListingId = (createLocked.json() as { listing: MarketplaceListing }).listing
      .listingId;

    const lockBeforeFreeze = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "freeze-lock-before" },
      payload: { listingId: lockedListingId, buyer: "buyer-freeze" },
    });
    assert.equal(lockBeforeFreeze.statusCode, 200);

    frozen = true;

    const createBlocked = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-FRZ-BLOCKED", seller: "seller-freeze", askPrice: "1200.0000" },
    });
    assert.equal(createBlocked.statusCode, 423);
    assert.equal(createBlocked.json().error, "marketplace_frozen");

    const lockBlocked = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "freeze-lock-blocked" },
      payload: { listingId: openListingId, buyer: "buyer-freeze-2" },
    });
    assert.equal(lockBlocked.statusCode, 423);
    assert.equal(lockBlocked.json().error, "marketplace_frozen");

    const settleBlocked = await app.inject({
      method: "POST",
      url: "/escrow/settle",
      headers: { "idempotency-key": "freeze-settle-blocked" },
      payload: { listingId: lockedListingId, buyer: "buyer-freeze" },
    });
    assert.equal(settleBlocked.statusCode, 423);
    assert.equal(settleBlocked.json().error, "marketplace_frozen");

    const cancelAllowed = await app.inject({
      method: "POST",
      url: "/escrow/cancel",
      headers: { "idempotency-key": "freeze-cancel-allowed" },
      payload: { listingId: lockedListingId, reason: "manual_risk_unwind" },
    });
    assert.equal(cancelAllowed.statusCode, 200);
    assert.equal(cancelAllowed.json().listing.status, "CANCELLED");
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("opens dispute for settled listing and sets underDispute soft state", async () => {
  const temp = createTempDbPath();
  const client = createCertificateClient({
    async getCertificate(certId) {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate(certId, "seller-dispute") },
      };
    },
  });
  const disputeClient = createDisputeClient();
  const app = await buildServer({
    certificateClient: client,
    disputeClient,
    dbPath: temp.dbPath,
  });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId: "DGC-LIST-DSP-1", seller: "seller-dispute", askPrice: "999.0000" },
    });
    assert.equal(createRes.statusCode, 201);
    const listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;

    const openBeforeSettle = await app.inject({
      method: "POST",
      url: `/listings/${encodeURIComponent(listingId)}/dispute/open`,
      payload: { openedBy: "buyer-dispute", reason: "not_received" },
    });
    assert.equal(openBeforeSettle.statusCode, 409);
    assert.equal(openBeforeSettle.json().error, "state_conflict");

    await app.inject({
      method: "POST",
      url: "/escrow/lock",
      headers: { "idempotency-key": "dsp-lock-1" },
      payload: { listingId, buyer: "buyer-dispute" },
    });
    await app.inject({
      method: "POST",
      url: "/escrow/settle",
      headers: { "idempotency-key": "dsp-settle-1" },
      payload: { listingId, buyer: "buyer-dispute", settledPrice: "990.0000" },
    });

    const openRes = await app.inject({
      method: "POST",
      url: `/listings/${encodeURIComponent(listingId)}/dispute/open`,
      payload: { openedBy: "buyer-dispute", reason: "delayed_delivery", evidence: { proof: "x" } },
    });
    assert.equal(openRes.statusCode, 200);
    const openBody = openRes.json() as {
      listing: MarketplaceListing;
      dispute: { disputeId: string; status: string };
    };
    assert.equal(openBody.listing.underDispute, true);
    assert.equal(openBody.listing.disputeStatus, "OPEN");
    assert.equal(typeof openBody.listing.disputeId, "string");
    assert.equal(openBody.dispute.status, "OPEN");

    const auditRes = await app.inject({
      method: "GET",
      url: `/listings/${encodeURIComponent(listingId)}/audit`,
    });
    assert.equal(auditRes.statusCode, 200);
    const auditBody = auditRes.json() as { events: ListingAuditEvent[] };
    assert.ok(auditBody.events.some((event) => event.type === "DISPUTE_OPENED"));

    const duplicateOpen = await app.inject({
      method: "POST",
      url: `/listings/${encodeURIComponent(listingId)}/dispute/open`,
      payload: { openedBy: "buyer-dispute", reason: "duplicate" },
    });
    assert.equal(duplicateOpen.statusCode, 409);
  } finally {
    await app.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});
