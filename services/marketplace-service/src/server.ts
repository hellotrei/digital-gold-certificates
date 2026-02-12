import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type {
  CancelEscrowRequest,
  CancelEscrowResponse,
  ChangeCertificateStatusRequest,
  ChangeCertificateStatusResponse,
  CreateListingRequest,
  CreateListingResponse,
  GetListingResponse,
  LockEscrowRequest,
  LockEscrowResponse,
  MarketplaceListing,
  SettleEscrowRequest,
  SettleEscrowResponse,
  SignedCertificate,
  TransferCertificateRequest,
  TransferCertificateResponse,
} from "@dgc/shared";

const DEFAULT_CERTIFICATE_SERVICE_URL = "http://127.0.0.1:4101";

interface HttpResult<T> {
  ok: boolean;
  status: number;
  data?: T;
}

export interface CertificateClient {
  getCertificate(certId: string): Promise<HttpResult<{ certificate: SignedCertificate }>>;
  changeStatus(
    request: ChangeCertificateStatusRequest,
  ): Promise<HttpResult<ChangeCertificateStatusResponse>>;
  transfer(
    request: TransferCertificateRequest,
  ): Promise<HttpResult<TransferCertificateResponse>>;
}

class HttpCertificateClient implements CertificateClient {
  constructor(private readonly baseUrl: string) {}

  async getCertificate(certId: string): Promise<HttpResult<{ certificate: SignedCertificate }>> {
    return requestJson<{ certificate: SignedCertificate }>(
      `${this.baseUrl}/certificates/${encodeURIComponent(certId)}`,
      { method: "GET" },
    );
  }

  async changeStatus(
    request: ChangeCertificateStatusRequest,
  ): Promise<HttpResult<ChangeCertificateStatusResponse>> {
    return requestJson<ChangeCertificateStatusResponse>(`${this.baseUrl}/certificates/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async transfer(
    request: TransferCertificateRequest,
  ): Promise<HttpResult<TransferCertificateResponse>> {
    return requestJson<TransferCertificateResponse>(`${this.baseUrl}/certificates/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAmount(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d{1,4})?$/.test(value);
}

function listingIdNow(): string {
  return `LST-${new Date().toISOString()}-${randomUUID().split("-")[0]}`;
}

function parseCreateListingRequest(body: unknown): CreateListingRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.certId)) return null;
  if (!isNonEmptyString(body.seller)) return null;
  if (!isAmount(body.askPrice)) return null;
  return {
    certId: body.certId,
    seller: body.seller,
    askPrice: body.askPrice,
  };
}

function parseLockEscrowRequest(body: unknown): LockEscrowRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.listingId)) return null;
  if (!isNonEmptyString(body.buyer)) return null;
  return {
    listingId: body.listingId,
    buyer: body.buyer,
  };
}

function parseSettleEscrowRequest(body: unknown): SettleEscrowRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.listingId)) return null;
  if (!isNonEmptyString(body.buyer)) return null;
  if (body.settledPrice !== undefined && !isAmount(body.settledPrice)) return null;
  return {
    listingId: body.listingId,
    buyer: body.buyer,
    settledPrice: body.settledPrice,
  };
}

function parseCancelEscrowRequest(body: unknown): CancelEscrowRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.listingId)) return null;
  if (body.reason !== undefined && !isNonEmptyString(body.reason)) return null;
  return {
    listingId: body.listingId,
    reason: body.reason,
  };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<HttpResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });

    const contentType = response.headers.get("content-type") || "";
    let data: unknown;
    if (contentType.includes("application/json")) {
      data = await response.json();
    }

    return {
      ok: response.ok,
      status: response.status,
      data: data as T,
    };
  } catch {
    return {
      ok: false,
      status: 0,
    };
  }
}

function getErrorMessage(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  return isNonEmptyString(payload.message) ? payload.message : undefined;
}

function sendCertificateServiceError(
  reply: { code: (statusCode: number) => { send: (payload: unknown) => void } },
  result: HttpResult<unknown>,
): void {
  if (result.status === 0) {
    reply.code(502).send({ error: "certificate_service_unreachable" });
    return;
  }

  if (result.status === 404) {
    reply.code(404).send({ error: "certificate_not_found" });
    return;
  }

  if (result.status === 409) {
    reply.code(409).send({
      error: "state_conflict",
      message: getErrorMessage(result.data) || "certificate_service_state_conflict",
    });
    return;
  }

  reply.code(502).send({
    error: "certificate_service_error",
    statusCode: result.status,
  });
}

interface BuildServerOptions {
  certificateClient?: CertificateClient;
  certificateServiceUrl?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const listings = new Map<string, MarketplaceListing>();

  const certificateClient =
    options.certificateClient ||
    new HttpCertificateClient(
      (options.certificateServiceUrl ||
        process.env.CERTIFICATE_SERVICE_URL ||
        DEFAULT_CERTIFICATE_SERVICE_URL
      ).replace(/\/$/, ""),
    );

  app.get("/health", async () => ({ ok: true, service: "marketplace-service" }));

  app.post("/listings/create", async (req, reply) => {
    const parsed = parseCreateListingRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected certId, seller, askPrice",
      });
    }

    const certResult = await certificateClient.getCertificate(parsed.certId);
    if (!certResult.ok) {
      sendCertificateServiceError(reply, certResult);
      return;
    }

    const certificate = certResult.data?.certificate;
    if (!certificate) {
      return reply.code(502).send({ error: "certificate_service_invalid_response" });
    }

    if (certificate.payload.owner !== parsed.seller) {
      return reply.code(409).send({
        error: "owner_mismatch",
        message: "Seller must match current certificate owner",
      });
    }

    if (certificate.payload.status !== "ACTIVE") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Only ACTIVE certificates can be listed",
      });
    }

    const now = new Date().toISOString();
    const listing: MarketplaceListing = {
      listingId: listingIdNow(),
      certId: parsed.certId,
      seller: parsed.seller,
      askPrice: parsed.askPrice,
      status: "OPEN",
      createdAt: now,
      updatedAt: now,
    };

    listings.set(listing.listingId, listing);
    const response: CreateListingResponse = { listing };
    return reply.code(201).send(response);
  });

  app.get("/listings/:listingId", async (req, reply) => {
    const params = req.params as { listingId?: string };
    if (!isNonEmptyString(params.listingId)) {
      return reply.code(400).send({ error: "invalid_listing_id" });
    }

    const listing = listings.get(params.listingId);
    if (!listing) {
      return reply.code(404).send({ error: "listing_not_found" });
    }

    const response: GetListingResponse = { listing };
    return response;
  });

  app.post("/escrow/lock", async (req, reply) => {
    const parsed = parseLockEscrowRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected listingId and buyer",
      });
    }

    const current = listings.get(parsed.listingId);
    if (!current) {
      return reply.code(404).send({ error: "listing_not_found" });
    }

    if (current.status !== "OPEN") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Only OPEN listings can be locked",
      });
    }

    const statusResult = await certificateClient.changeStatus({
      certId: current.certId,
      status: "LOCKED",
    });
    if (!statusResult.ok) {
      sendCertificateServiceError(reply, statusResult);
      return;
    }

    const now = new Date().toISOString();
    const updated: MarketplaceListing = {
      ...current,
      status: "LOCKED",
      lockedBy: parsed.buyer,
      lockedAt: now,
      updatedAt: now,
    };
    listings.set(updated.listingId, updated);

    const response: LockEscrowResponse = { listing: updated };
    return response;
  });

  app.post("/escrow/settle", async (req, reply) => {
    const parsed = parseSettleEscrowRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected listingId, buyer, and optional settledPrice",
      });
    }

    const current = listings.get(parsed.listingId);
    if (!current) {
      return reply.code(404).send({ error: "listing_not_found" });
    }

    if (current.status !== "LOCKED") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Only LOCKED listings can be settled",
      });
    }

    if (current.lockedBy !== parsed.buyer) {
      return reply.code(409).send({
        error: "buyer_mismatch",
        message: "Settlement buyer must match lock buyer",
      });
    }

    const unlockResult = await certificateClient.changeStatus({
      certId: current.certId,
      status: "ACTIVE",
    });
    if (!unlockResult.ok) {
      sendCertificateServiceError(reply, unlockResult);
      return;
    }

    const settledPrice = parsed.settledPrice || current.askPrice;
    const transferResult = await certificateClient.transfer({
      certId: current.certId,
      toOwner: parsed.buyer,
      price: settledPrice,
    });

    if (!transferResult.ok) {
      // Best-effort rollback to LOCKED if transfer fails after unlock.
      await certificateClient.changeStatus({
        certId: current.certId,
        status: "LOCKED",
      });
      sendCertificateServiceError(reply, transferResult);
      return;
    }

    const transfer = transferResult.data;
    if (!transfer) {
      return reply.code(502).send({ error: "certificate_service_invalid_response" });
    }

    const now = new Date().toISOString();
    const updated: MarketplaceListing = {
      ...current,
      status: "SETTLED",
      settledPrice,
      settledAt: now,
      updatedAt: now,
    };
    listings.set(updated.listingId, updated);

    const response: SettleEscrowResponse = {
      listing: updated,
      transfer,
    };
    return response;
  });

  app.post("/escrow/cancel", async (req, reply) => {
    const parsed = parseCancelEscrowRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected listingId and optional reason",
      });
    }

    const current = listings.get(parsed.listingId);
    if (!current) {
      return reply.code(404).send({ error: "listing_not_found" });
    }

    if (current.status === "SETTLED" || current.status === "CANCELLED") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Listing is already terminal",
      });
    }

    if (current.status === "LOCKED") {
      const unlockResult = await certificateClient.changeStatus({
        certId: current.certId,
        status: "ACTIVE",
      });
      if (!unlockResult.ok) {
        sendCertificateServiceError(reply, unlockResult);
        return;
      }
    }

    const now = new Date().toISOString();
    const updated: MarketplaceListing = {
      ...current,
      status: "CANCELLED",
      cancelledAt: now,
      cancelReason: parsed.reason,
      updatedAt: now,
    };
    listings.set(updated.listingId, updated);

    const response: CancelEscrowResponse = { listing: updated };
    return response;
  });

  return app;
}
