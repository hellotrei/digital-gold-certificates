import Fastify from "fastify";
import {
  canonicalJson,
  sha256Hex,
  type LedgerEvent,
  type AnchorProofRequest,
  type AnchorProofResponse,
  type GetTimelineResponse,
  type ProofAnchorRecord,
  type RecordLedgerEventRequest,
  type RecordLedgerEventResponse,
} from "@dgc/shared";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAnchorProofRequest(body: unknown): body is AnchorProofRequest {
  if (!isObject(body)) return false;
  return (
    isNonEmptyString(body.certId) &&
    isNonEmptyString(body.payloadHash) &&
    isNonEmptyString(body.occurredAt)
  );
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (!isObject(value)) return false;
  if (!isNonEmptyString(value.type)) return false;
  if (!isNonEmptyString(value.certId)) return false;
  if (!isNonEmptyString(value.occurredAt)) return false;

  if (value.type === "ISSUED") {
    return (
      isNonEmptyString(value.owner) &&
      isNonEmptyString(value.amountGram) &&
      isNonEmptyString(value.purity)
    );
  }
  if (value.type === "TRANSFER") {
    return (
      isNonEmptyString(value.from) &&
      isNonEmptyString(value.to) &&
      isNonEmptyString(value.amountGram)
    );
  }
  if (value.type === "SPLIT") {
    return (
      isNonEmptyString(value.parentCertId) &&
      isNonEmptyString(value.childCertId) &&
      isNonEmptyString(value.from) &&
      isNonEmptyString(value.to) &&
      isNonEmptyString(value.amountChildGram)
    );
  }
  if (value.type === "STATUS_CHANGED") {
    return isNonEmptyString(value.status);
  }

  return false;
}

function isRecordLedgerEventRequest(body: unknown): body is RecordLedgerEventRequest {
  if (!isObject(body)) return false;
  return isLedgerEvent(body.event);
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  const proofStore = new Map<string, ProofAnchorRecord>();
  const eventStore = new Map<string, LedgerEvent[]>();

  app.get("/health", async () => ({ ok: true, service: "ledger-adapter" }));

  app.post("/proofs/anchor", async (req, reply) => {
    if (!isAnchorProofRequest(req.body)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected certId, payloadHash, occurredAt",
      });
    }

    const body = req.body;
    const anchoredAt = new Date().toISOString();
    const proofHash = sha256Hex(
      canonicalJson({
        certId: body.certId,
        payloadHash: body.payloadHash,
        occurredAt: body.occurredAt,
        anchoredAt,
      }),
    );

    const proof: ProofAnchorRecord = {
      certId: body.certId,
      payloadHash: body.payloadHash,
      proofHash,
      anchoredAt,
    };
    proofStore.set(body.certId, proof);

    const response: AnchorProofResponse = { proof };
    return reply.code(201).send(response);
  });

  app.get("/proofs/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }

    const proof = proofStore.get(params.certId);
    if (!proof) {
      return reply.code(404).send({ error: "proof_not_found" });
    }

    return { proof };
  });

  app.post("/events/record", async (req, reply) => {
    if (!isRecordLedgerEventRequest(req.body)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected event payload following LedgerEvent schema",
      });
    }

    const event = req.body.event;
    const eventHash = sha256Hex(canonicalJson(event));
    const mainTimeline = eventStore.get(event.certId) || [];
    mainTimeline.push(event);
    eventStore.set(event.certId, mainTimeline);

    // Split events are relevant to both parent and child lineage.
    if (event.type === "SPLIT") {
      const childTimeline = eventStore.get(event.childCertId) || [];
      childTimeline.push(event);
      eventStore.set(event.childCertId, childTimeline);
    }

    const response: RecordLedgerEventResponse = {
      event,
      eventHash,
    };
    return reply.code(201).send(response);
  });

  app.get("/events/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }

    const events = eventStore.get(params.certId) || [];
    const response: GetTimelineResponse = {
      certId: params.certId,
      events,
    };
    return response;
  });

  return app;
}
