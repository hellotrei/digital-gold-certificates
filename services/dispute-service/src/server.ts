import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type {
  AssignDisputeRequest,
  AssignDisputeResponse,
  DisputeRecord,
  DisputeResolution,
  DisputeStatus,
  GetDisputeResponse,
  ListDisputesResponse,
  OpenDisputeRequest,
  OpenDisputeResponse,
  ResolveDisputeRequest,
  ResolveDisputeResponse,
} from "@dgc/shared";
import { isServiceAuthAuthorized, SERVICE_AUTH_HEADER } from "@dgc/shared";
import { SqliteDisputeStore, type DisputeStore } from "./storage/dispute-store.js";

const DEFAULT_DISPUTE_DB_PATH = "data/dispute-service.db";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDisputeStatus(value: unknown): value is DisputeStatus {
  return value === "OPEN" || value === "ASSIGNED" || value === "RESOLVED";
}

function isDisputeResolution(value: unknown): value is DisputeResolution {
  return value === "REFUND_BUYER" || value === "RELEASE_SELLER" || value === "MANUAL_REVIEW";
}

function parseOpenDisputeRequest(body: unknown): OpenDisputeRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.listingId)) return null;
  if (!isNonEmptyString(body.certId)) return null;
  if (!isNonEmptyString(body.openedBy)) return null;
  if (!isNonEmptyString(body.reason)) return null;
  if (body.evidence !== undefined && !isObject(body.evidence)) return null;
  return {
    listingId: body.listingId,
    certId: body.certId,
    openedBy: body.openedBy,
    reason: body.reason,
    evidence: body.evidence,
  };
}

function parseAssignDisputeRequest(body: unknown): AssignDisputeRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.assignee)) return null;
  return { assignee: body.assignee };
}

function parseResolveDisputeRequest(body: unknown): ResolveDisputeRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.resolvedBy)) return null;
  if (!isDisputeResolution(body.resolution)) return null;
  if (body.resolutionNotes !== undefined && !isNonEmptyString(body.resolutionNotes)) return null;
  return {
    resolvedBy: body.resolvedBy,
    resolution: body.resolution,
    resolutionNotes: body.resolutionNotes,
  };
}

function disputeIdNow(): string {
  return `DSP-${new Date().toISOString()}-${randomUUID().split("-")[0]}`;
}

interface BuildServerOptions {
  disputeStore?: DisputeStore;
  dbPath?: string;
  serviceAuthToken?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const disputeStore =
    options.disputeStore ||
    new SqliteDisputeStore(options.dbPath || process.env.DISPUTE_DB_PATH || DEFAULT_DISPUTE_DB_PATH);
  const ownStore = !options.disputeStore;
  const serviceAuthToken = options.serviceAuthToken ?? process.env.SERVICE_AUTH_TOKEN;

  function requireServiceAuth(
    req: { headers: Record<string, unknown> },
    reply: { code: (statusCode: number) => { send: (payload: unknown) => void } },
  ): boolean {
    if (isServiceAuthAuthorized(req.headers[SERVICE_AUTH_HEADER], serviceAuthToken)) {
      return true;
    }
    reply.code(401).send({
      error: "unauthorized_service",
      message: `Missing or invalid '${SERVICE_AUTH_HEADER}' header`,
    });
    return false;
  }

  app.get("/health", async () => ({ ok: true, service: "dispute-service" }));

  app.post("/disputes/open", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const parsed = parseOpenDisputeRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected listingId, certId, openedBy, reason, and optional evidence object",
      });
    }

    const openedAt = new Date().toISOString();
    const dispute: DisputeRecord = {
      disputeId: disputeIdNow(),
      listingId: parsed.listingId,
      certId: parsed.certId,
      status: "OPEN",
      openedBy: parsed.openedBy,
      reason: parsed.reason,
      evidence: parsed.evidence,
      openedAt,
    };
    disputeStore.create(dispute);
    const response: OpenDisputeResponse = { dispute };
    return reply.code(201).send(response);
  });

  app.post("/disputes/:disputeId/assign", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const params = req.params as { disputeId?: string };
    const parsed = parseAssignDisputeRequest(req.body);
    if (!isNonEmptyString(params.disputeId) || !parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected disputeId param and assignee field",
      });
    }

    const current = disputeStore.get(params.disputeId);
    if (!current) {
      return reply.code(404).send({ error: "dispute_not_found" });
    }
    if (current.status === "RESOLVED") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Resolved disputes cannot be assigned",
      });
    }

    const updated: DisputeRecord = {
      ...current,
      status: "ASSIGNED",
      assignedTo: parsed.assignee,
      assignedAt: new Date().toISOString(),
    };
    disputeStore.update(updated);
    const response: AssignDisputeResponse = { dispute: updated };
    return response;
  });

  app.post("/disputes/:disputeId/resolve", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const params = req.params as { disputeId?: string };
    const parsed = parseResolveDisputeRequest(req.body);
    if (!isNonEmptyString(params.disputeId) || !parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected disputeId param, resolvedBy, resolution and optional resolutionNotes",
      });
    }

    const current = disputeStore.get(params.disputeId);
    if (!current) {
      return reply.code(404).send({ error: "dispute_not_found" });
    }
    if (current.status === "RESOLVED") {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Dispute is already resolved",
      });
    }

    const updated: DisputeRecord = {
      ...current,
      status: "RESOLVED",
      resolvedBy: parsed.resolvedBy,
      resolvedAt: new Date().toISOString(),
      resolution: parsed.resolution,
      resolutionNotes: parsed.resolutionNotes,
    };
    disputeStore.update(updated);
    const response: ResolveDisputeResponse = { dispute: updated };
    return response;
  });

  app.get("/disputes/:disputeId", async (req, reply) => {
    const params = req.params as { disputeId?: string };
    if (!isNonEmptyString(params.disputeId)) {
      return reply.code(400).send({ error: "invalid_dispute_id" });
    }
    const dispute = disputeStore.get(params.disputeId);
    if (!dispute) {
      return reply.code(404).send({ error: "dispute_not_found" });
    }
    const response: GetDisputeResponse = { dispute };
    return response;
  });

  app.get("/disputes", async (req, reply) => {
    const query = req.query as { status?: string };
    if (query.status !== undefined && !isDisputeStatus(query.status)) {
      return reply.code(400).send({
        error: "invalid_status",
      });
    }
    const response: ListDisputesResponse = {
      disputes: disputeStore.list(query.status as DisputeStatus | undefined),
    };
    return response;
  });

  app.addHook("onClose", async () => {
    if (ownStore) {
      disputeStore.close();
    }
  });

  return app;
}
