import Fastify from "fastify";
import {
  buildServiceAuthHeaders,
  canonicalJson,
  isServiceAuthAuthorized,
  SERVICE_AUTH_HEADER,
  sha256Hex,
  type LedgerEvent,
  type AnchorProofRequest,
  type AnchorProofResponse,
  type GetTimelineResponse,
  type ProofAnchorRecord,
  type RecordLedgerEventRequest,
  type RecordLedgerEventResponse,
} from "@dgc/shared";
import {
  buildChainWriterFromEnv,
  type ChainStatusResult,
  type ChainWriter,
} from "./chain.js";

interface BuildServerOptions {
  chainWriter?: ChainWriter | null;
  riskStreamUrl?: string;
  serviceAuthToken?: string;
}

interface StoredEvent {
  event: LedgerEvent;
  eventHash: string;
  ledgerTxRef?: string;
}

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

async function tryPublishRiskEvent(
  riskStreamUrl: string | undefined,
  event: LedgerEvent,
  serviceAuthToken: string | undefined,
): Promise<void> {
  if (!riskStreamUrl) return;
  try {
    const authHeaders = buildServiceAuthHeaders(serviceAuthToken);
    await fetch(`${riskStreamUrl.replace(/\/$/, "")}/ingest/ledger-event`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ event }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort publish; do not fail primary event recording path.
  }
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const proofStore = new Map<string, ProofAnchorRecord>();
  const eventStore = new Map<string, StoredEvent[]>();
  const chainWriter =
    options.chainWriter === undefined ? buildChainWriterFromEnv() : options.chainWriter;
  const riskStreamUrl = options.riskStreamUrl ?? process.env.RISK_STREAM_URL;
  const serviceAuthToken = options.serviceAuthToken ?? process.env.SERVICE_AUTH_TOKEN;

  function requireServiceAuth(req: { headers: Record<string, unknown> }, reply: { code: (statusCode: number) => { send: (payload: unknown) => void } }): boolean {
    if (isServiceAuthAuthorized(req.headers[SERVICE_AUTH_HEADER], serviceAuthToken)) {
      return true;
    }
    reply.code(401).send({
      error: "unauthorized_service",
      message: `Missing or invalid '${SERVICE_AUTH_HEADER}' header`,
    });
    return false;
  }

  app.get("/health", async () => ({ ok: true, service: "ledger-adapter" }));

  app.get("/chain/status", async () => {
    if (!chainWriter) {
      const status: ChainStatusResult = { configured: false };
      return status;
    }
    return chainWriter.status();
  });

  app.post("/proofs/anchor", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

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
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    if (!isRecordLedgerEventRequest(req.body)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected event payload following LedgerEvent schema",
      });
    }

    const event = req.body.event;
    const eventHash = sha256Hex(canonicalJson(event));
    let ledgerTxRef: string | undefined;

    if (chainWriter) {
      try {
        const chainResult = await chainWriter.recordEvent(event);
        ledgerTxRef = chainResult.txHash;
      } catch (error) {
        return reply.code(502).send({
          error: "chain_write_failed",
          message: error instanceof Error ? error.message : "unknown_error",
        });
      }
    }

    const record: StoredEvent = { event, eventHash, ledgerTxRef };

    const mainTimeline = eventStore.get(event.certId) || [];
    mainTimeline.push(record);
    eventStore.set(event.certId, mainTimeline);

    if (event.type === "SPLIT") {
      const childTimeline = eventStore.get(event.childCertId) || [];
      childTimeline.push(record);
      eventStore.set(event.childCertId, childTimeline);
    }

    const response: RecordLedgerEventResponse = {
      event,
      eventHash,
      ledgerTxRef,
    };

    await tryPublishRiskEvent(riskStreamUrl, event, serviceAuthToken);
    return reply.code(201).send(response);
  });

  app.get("/events/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }

    const records = eventStore.get(params.certId) || [];
    const events = records.map((record) => record.event);
    const response: GetTimelineResponse = {
      certId: params.certId,
      events,
    };
    return response;
  });

  return app;
}
