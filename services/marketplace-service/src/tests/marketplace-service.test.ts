import assert from "node:assert/strict";
import test from "node:test";
import type {
  CertificateStatus,
  ChangeCertificateStatusRequest,
  ChangeCertificateStatusResponse,
  MarketplaceListing,
  SignedCertificate,
  TransferCertificateRequest,
  TransferCertificateResponse,
} from "@dgc/shared";
import { buildServer, type CertificateClient } from "../server.js";

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

test("creates listing and fetches by id", async () => {
  const certId = "DGC-LIST-001";
  const client: CertificateClient = {
    async getCertificate(requestedCertId) {
      assert.equal(requestedCertId, certId);
      return { ok: true, status: 200, data: { certificate: makeCertificate(certId, "seller-A") } };
    },
    async changeStatus() {
      throw new Error("not used");
    },
    async transfer() {
      throw new Error("not used");
    },
  };

  const app = await buildServer({ certificateClient: client });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId, seller: "seller-A", askPrice: "1000.0000" },
    });
    assert.equal(createRes.statusCode, 201);

    const createBody = createRes.json() as { listing: MarketplaceListing };
    assert.equal(createBody.listing.status, "OPEN");

    const getRes = await app.inject({
      method: "GET",
      url: `/listings/${encodeURIComponent(createBody.listing.listingId)}`,
    });
    assert.equal(getRes.statusCode, 200);
    const getBody = getRes.json() as { listing: MarketplaceListing };
    assert.equal(getBody.listing.certId, certId);
  } finally {
    await app.close();
  }
});

test("rejects listing when seller does not match current owner", async () => {
  const client: CertificateClient = {
    async getCertificate() {
      return {
        ok: true,
        status: 200,
        data: { certificate: makeCertificate("DGC-LIST-002", "owner-real") },
      };
    },
    async changeStatus() {
      throw new Error("not used");
    },
    async transfer() {
      throw new Error("not used");
    },
  };

  const app = await buildServer({ certificateClient: client });
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
  }
});

test("locks listing via certificate status transition", async () => {
  const certId = "DGC-LIST-003";
  const statusCalls: ChangeCertificateStatusRequest[] = [];

  const client: CertificateClient = {
    async getCertificate() {
      return { ok: true, status: 200, data: { certificate: makeCertificate(certId, "seller-C") } };
    },
    async changeStatus(request) {
      statusCalls.push(request);
      const response: ChangeCertificateStatusResponse = {
        certificate: makeCertificate(certId, "seller-C", request.status),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
    async transfer() {
      throw new Error("not used");
    },
  };

  const app = await buildServer({ certificateClient: client });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId, seller: "seller-C", askPrice: "1200.0000" },
    });
    const listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;

    const lockRes = await app.inject({
      method: "POST",
      url: "/escrow/lock",
      payload: { listingId, buyer: "buyer-C" },
    });
    assert.equal(lockRes.statusCode, 200);
    const body = lockRes.json() as { listing: MarketplaceListing };
    assert.equal(body.listing.status, "LOCKED");
    assert.equal(body.listing.lockedBy, "buyer-C");
    assert.deepEqual(statusCalls, [{ certId, status: "LOCKED" }]);
  } finally {
    await app.close();
  }
});

test("settles LOCKED listing with unlock + transfer sequence", async () => {
  const certId = "DGC-LIST-004";
  const ops: string[] = [];

  const client: CertificateClient = {
    async getCertificate() {
      return { ok: true, status: 200, data: { certificate: makeCertificate(certId, "seller-D") } };
    },
    async changeStatus(request) {
      ops.push(`status:${request.status}`);
      const response: ChangeCertificateStatusResponse = {
        certificate: makeCertificate(certId, "seller-D", request.status),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
    async transfer(request: TransferCertificateRequest) {
      ops.push("transfer");
      const response: TransferCertificateResponse = {
        certificate: makeCertificate(certId, request.toOwner, "ACTIVE"),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
  };

  const app = await buildServer({ certificateClient: client });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId, seller: "seller-D", askPrice: "1500.0000" },
    });
    const listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;

    await app.inject({
      method: "POST",
      url: "/escrow/lock",
      payload: { listingId, buyer: "buyer-D" },
    });

    const settleRes = await app.inject({
      method: "POST",
      url: "/escrow/settle",
      payload: { listingId, buyer: "buyer-D", settledPrice: "1499.0000" },
    });
    assert.equal(settleRes.statusCode, 200);
    const settleBody = settleRes.json() as { listing: MarketplaceListing };
    assert.equal(settleBody.listing.status, "SETTLED");
    assert.equal(settleBody.listing.settledPrice, "1499.0000");
    assert.deepEqual(ops, ["status:LOCKED", "status:ACTIVE", "transfer"]);
  } finally {
    await app.close();
  }
});

test("cancels LOCKED listing and unlocks certificate", async () => {
  const certId = "DGC-LIST-005";
  const ops: string[] = [];

  const client: CertificateClient = {
    async getCertificate() {
      return { ok: true, status: 200, data: { certificate: makeCertificate(certId, "seller-E") } };
    },
    async changeStatus(request) {
      ops.push(`status:${request.status}`);
      const response: ChangeCertificateStatusResponse = {
        certificate: makeCertificate(certId, "seller-E", request.status),
        proofAnchorStatus: "SKIPPED",
        eventWriteStatus: "SKIPPED",
      };
      return { ok: true, status: 200, data: response };
    },
    async transfer() {
      throw new Error("not used");
    },
  };

  const app = await buildServer({ certificateClient: client });
  try {
    const createRes = await app.inject({
      method: "POST",
      url: "/listings/create",
      payload: { certId, seller: "seller-E", askPrice: "1550.0000" },
    });
    const listingId = (createRes.json() as { listing: MarketplaceListing }).listing.listingId;

    await app.inject({
      method: "POST",
      url: "/escrow/lock",
      payload: { listingId, buyer: "buyer-E" },
    });

    const cancelRes = await app.inject({
      method: "POST",
      url: "/escrow/cancel",
      payload: { listingId, reason: "buyer_timeout" },
    });
    assert.equal(cancelRes.statusCode, 200);
    const cancelBody = cancelRes.json() as { listing: MarketplaceListing };
    assert.equal(cancelBody.listing.status, "CANCELLED");
    assert.equal(cancelBody.listing.cancelReason, "buyer_timeout");
    assert.deepEqual(ops, ["status:LOCKED", "status:ACTIVE"]);
  } finally {
    await app.close();
  }
});
