import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  type CancelEscrowRequest,
  type CancelEscrowResponse,
  canonicalJson,
  type ChangeCertificateStatusRequest,
  type ChangeCertificateStatusResponse,
  type CreateListingRequest,
  type CreateListingResponse,
  type GetListingAuditResponse,
  type GetLatestReconciliationResponse,
  type GetListingResponse,
  type ListListingsResponse,
  type ListingAuditEvent,
  type ListingStatus,
  type LockEscrowRequest,
  type LockEscrowResponse,
  type MarketplaceListing,
  type SettleEscrowRequest,
  type SettleEscrowResponse,
  sha256Hex,
  type SignedCertificate,
  type TransferCertificateRequest,
  type TransferCertificateResponse,
} from "@dgc/shared";
import {
  type ListingStore,
  SqliteListingStore,
} from "./storage/listing-store.js";

const DEFAULT_CERTIFICATE_SERVICE_URL = "http://127.0.0.1:4101";
const DEFAULT_MARKETPLACE_DB_PATH = "data/marketplace-service.db";
const IDEMPOTENCY_HEADER = "idempotency-key";

type EscrowAction = "LOCK_ESCROW" | "SETTLE_ESCROW" | "CANCEL_ESCROW";

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

export interface ReconciliationClient {
  getLatest(): Promise<HttpResult<GetLatestReconciliationResponse>>;
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

class HttpReconciliationClient implements ReconciliationClient {
  constructor(private readonly baseUrl: string) {}

  async getLatest(): Promise<HttpResult<GetLatestReconciliationResponse>> {
    return requestJson<GetLatestReconciliationResponse>(`${this.baseUrl}/reconcile/latest`, {
      method: "GET",
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

function isListingStatus(value: unknown): value is ListingStatus {
  return value === "OPEN" || value === "LOCKED" || value === "SETTLED" || value === "CANCELLED";
}

function listingIdNow(): string {
  return `LST-${new Date().toISOString()}-${randomUUID().split("-")[0]}`;
}

function listingAuditEventIdNow(): string {
  return `AUD-${new Date().toISOString()}-${randomUUID().split("-")[0]}`;
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

function parseListQuery(query: unknown): { status?: ListingStatus } | null {
  if (query === undefined) return {};
  if (!isObject(query)) return null;

  if (query.status === undefined) return {};
  if (!isListingStatus(query.status)) return null;
  return { status: query.status };
}

function readIdempotencyKey(req: FastifyRequest): string | null {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  if (Array.isArray(raw)) {
    const first = raw[0];
    return isNonEmptyString(first) ? first.trim() : null;
  }
  if (!isNonEmptyString(raw)) return null;
  return raw.trim();
}

function writeAuditEvent(
  listingStore: ListingStore,
  listingId: string,
  type: ListingAuditEvent["type"],
  actor?: string,
  details?: Record<string, unknown>,
): ListingAuditEvent {
  const event: ListingAuditEvent = {
    eventId: listingAuditEventIdNow(),
    listingId,
    type,
    actor,
    occurredAt: new Date().toISOString(),
    details,
  };
  listingStore.appendAuditEvent(event);
  return event;
}

async function tryPublishListingAuditEvent(
  riskStreamUrl: string | undefined,
  event: ListingAuditEvent,
  listing: MarketplaceListing,
): Promise<void> {
  if (!riskStreamUrl) return;
  try {
    await fetch(`${riskStreamUrl.replace(/\/$/, "")}/ingest/listing-audit-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, listing }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort publish; do not fail marketplace primary flow.
  }
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

function sendCertificateServiceError(reply: FastifyReply, result: HttpResult<unknown>): void {
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

async function enforceFreezeGuard(
  reply: FastifyReply,
  reconciliationClient?: ReconciliationClient,
): Promise<boolean> {
  if (!reconciliationClient) return true;

  const result = await reconciliationClient.getLatest();
  if (!result.ok) {
    if (result.status === 0) {
      reply.code(503).send({ error: "reconciliation_service_unreachable" });
      return false;
    }
    reply.code(502).send({
      error: "reconciliation_service_error",
      statusCode: result.status,
    });
    return false;
  }

  const freezeState = result.data?.freezeState;
  if (!freezeState || typeof freezeState.active !== "boolean") {
    reply.code(502).send({ error: "reconciliation_service_invalid_response" });
    return false;
  }

  if (freezeState.active) {
    reply.code(423).send({
      error: "marketplace_frozen",
      message: freezeState.reason || "Marketplace write actions are frozen by reconciliation control",
      freezeState,
    });
    return false;
  }

  return true;
}

function replayIdempotentIfExists(
  reply: FastifyReply,
  listingStore: ListingStore,
  action: EscrowAction,
  idempotencyKey: string,
  requestHash: string,
): boolean {
  const existing = listingStore.getIdempotencyRecord(action, idempotencyKey);
  if (!existing) return false;

  if (existing.requestHash !== requestHash) {
    reply.code(409).send({
      error: "idempotency_key_reuse_conflict",
      message: "Idempotency key already used with different payload",
    });
    return true;
  }

  reply.code(existing.responseStatus).send(existing.responseBody);
  return true;
}

function saveIdempotentResponse(
  listingStore: ListingStore,
  action: EscrowAction,
  idempotencyKey: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown,
): void {
  listingStore.putIdempotencyRecord({
    action,
    idempotencyKey,
    requestHash,
    responseStatus,
    responseBody,
    createdAt: new Date().toISOString(),
  });
}

interface BuildServerOptions {
  certificateClient?: CertificateClient;
  certificateServiceUrl?: string;
  reconciliationClient?: ReconciliationClient;
  reconciliationServiceUrl?: string;
  riskStreamUrl?: string;
  listingStore?: ListingStore;
  dbPath?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const listingStore =
    options.listingStore ||
    new SqliteListingStore(
      options.dbPath || process.env.MARKETPLACE_DB_PATH || DEFAULT_MARKETPLACE_DB_PATH,
    );
  const ownListingStore = !options.listingStore;

  const certificateClient =
    options.certificateClient ||
    new HttpCertificateClient(
      (options.certificateServiceUrl ||
        process.env.CERTIFICATE_SERVICE_URL ||
        DEFAULT_CERTIFICATE_SERVICE_URL
      ).replace(/\/$/, ""),
    );
  const reconciliationServiceUrl =
    options.reconciliationServiceUrl ?? process.env.RECONCILIATION_SERVICE_URL;
  const reconciliationClient =
    options.reconciliationClient ||
    (reconciliationServiceUrl
      ? new HttpReconciliationClient(reconciliationServiceUrl.replace(/\/$/, ""))
      : undefined);
  const riskStreamUrl = options.riskStreamUrl ?? process.env.RISK_STREAM_URL;

  app.get("/health", async () => ({ ok: true, service: "marketplace-service" }));

  app.post("/listings/create", async (req, reply) => {
    const parsed = parseCreateListingRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected certId, seller, askPrice",
      });
    }

    if (!(await enforceFreezeGuard(reply, reconciliationClient))) {
      return;
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

    listingStore.putListing(listing);
    const auditEvent = writeAuditEvent(listingStore, listing.listingId, "CREATED", parsed.seller, {
      certId: parsed.certId,
      askPrice: parsed.askPrice,
    });
    await tryPublishListingAuditEvent(riskStreamUrl, auditEvent, listing);

    const response: CreateListingResponse = { listing };
    return reply.code(201).send(response);
  });

  app.get("/listings", async (req, reply) => {
    const parsedQuery = parseListQuery(req.query);
    if (!parsedQuery) {
      return reply.code(400).send({
        error: "invalid_query",
        message: "status must be one of OPEN, LOCKED, SETTLED, CANCELLED",
      });
    }

    const listings = listingStore.listListings({ status: parsedQuery.status });
    const response: ListListingsResponse = { listings };
    return response;
  });

  app.get("/listings/:listingId/audit", async (req, reply) => {
    const params = req.params as { listingId?: string };
    if (!isNonEmptyString(params.listingId)) {
      return reply.code(400).send({ error: "invalid_listing_id" });
    }

    const listing = listingStore.getListing(params.listingId);
    if (!listing) {
      return reply.code(404).send({ error: "listing_not_found" });
    }

    const response: GetListingAuditResponse = {
      listingId: params.listingId,
      events: listingStore.getAuditEvents(params.listingId),
    };
    return response;
  });

  app.get("/listings/:listingId", async (req, reply) => {
    const params = req.params as { listingId?: string };
    if (!isNonEmptyString(params.listingId)) {
      return reply.code(400).send({ error: "invalid_listing_id" });
    }

    const listing = listingStore.getListing(params.listingId);
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

    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) {
      return reply.code(400).send({
        error: "missing_idempotency_key",
        message: `Set '${IDEMPOTENCY_HEADER}' header`,
      });
    }

    const requestHash = sha256Hex(canonicalJson(parsed));
    if (replayIdempotentIfExists(reply, listingStore, "LOCK_ESCROW", idempotencyKey, requestHash)) {
      return;
    }

    const current = listingStore.getListing(parsed.listingId);
    if (!current) {
      return reply.code(404).send({ error: "listing_not_found" });
    }

    if (current.status !== "OPEN") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Only OPEN listings can be locked",
      });
    }

    if (!(await enforceFreezeGuard(reply, reconciliationClient))) {
      return;
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
    listingStore.putListing(updated);
    const auditEvent = writeAuditEvent(listingStore, updated.listingId, "LOCKED", parsed.buyer, {
      idempotencyKey,
      fromStatus: current.status,
      toStatus: updated.status,
    });
    await tryPublishListingAuditEvent(riskStreamUrl, auditEvent, updated);

    const response: LockEscrowResponse = { listing: updated };
    saveIdempotentResponse(
      listingStore,
      "LOCK_ESCROW",
      idempotencyKey,
      requestHash,
      200,
      response,
    );
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

    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) {
      return reply.code(400).send({
        error: "missing_idempotency_key",
        message: `Set '${IDEMPOTENCY_HEADER}' header`,
      });
    }

    const requestHash = sha256Hex(canonicalJson(parsed));
    if (
      replayIdempotentIfExists(reply, listingStore, "SETTLE_ESCROW", idempotencyKey, requestHash)
    ) {
      return;
    }

    const current = listingStore.getListing(parsed.listingId);
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

    if (!(await enforceFreezeGuard(reply, reconciliationClient))) {
      return;
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
    listingStore.putListing(updated);
    const auditEvent = writeAuditEvent(listingStore, updated.listingId, "SETTLED", parsed.buyer, {
      idempotencyKey,
      fromStatus: current.status,
      toStatus: updated.status,
      settledPrice,
    });
    await tryPublishListingAuditEvent(riskStreamUrl, auditEvent, updated);

    const response: SettleEscrowResponse = {
      listing: updated,
      transfer,
    };
    saveIdempotentResponse(
      listingStore,
      "SETTLE_ESCROW",
      idempotencyKey,
      requestHash,
      200,
      response,
    );
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

    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) {
      return reply.code(400).send({
        error: "missing_idempotency_key",
        message: `Set '${IDEMPOTENCY_HEADER}' header`,
      });
    }

    const requestHash = sha256Hex(canonicalJson(parsed));
    if (
      replayIdempotentIfExists(reply, listingStore, "CANCEL_ESCROW", idempotencyKey, requestHash)
    ) {
      return;
    }

    const current = listingStore.getListing(parsed.listingId);
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
    listingStore.putListing(updated);
    const auditEvent = writeAuditEvent(
      listingStore,
      updated.listingId,
      "CANCELLED",
      current.lockedBy || current.seller,
      {
      idempotencyKey,
      fromStatus: current.status,
      toStatus: updated.status,
      reason: parsed.reason,
    });
    await tryPublishListingAuditEvent(riskStreamUrl, auditEvent, updated);

    const response: CancelEscrowResponse = { listing: updated };
    saveIdempotentResponse(
      listingStore,
      "CANCEL_ESCROW",
      idempotencyKey,
      requestHash,
      200,
      response,
    );
    return response;
  });

  app.addHook("onClose", async () => {
    if (ownListingStore) {
      listingStore.close();
    }
  });

  return app;
}
