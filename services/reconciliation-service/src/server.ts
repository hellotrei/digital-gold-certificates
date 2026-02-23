import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type {
  FreezeState,
  FreezeOverrideRecord,
  GetLatestReconciliationResponse,
  IngestReconciliationAlertRequest,
  ListFreezeOverridesResponse,
  ListCertificatesResponse,
  ListReconciliationHistoryResponse,
  ManualUnfreezeRequest,
  ManualUnfreezeResponse,
  ReconciliationRun,
  RunReconciliationRequest,
  RunReconciliationResponse,
  SignedCertificate,
} from "@dgc/shared";
import {
  buildServiceAuthHeaders,
  isServiceAuthAuthorized,
  SERVICE_AUTH_HEADER,
} from "@dgc/shared";
import { SqliteReconciliationStore, type ReconciliationStore } from "./storage/reconciliation-store.js";

const DEFAULT_RECON_DB_PATH = "data/reconciliation-service.db";
const DEFAULT_CERTIFICATE_SERVICE_URL = "http://127.0.0.1:4101";
const DEFAULT_CUSTODY_TOTAL_GRAM = "0.0000";
const DEFAULT_MISMATCH_THRESHOLD_GRAM = "0.5000";
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_OVERRIDE_HISTORY_LIMIT = 20;
const AMOUNT_SCALE = 10000n;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAmountGram(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d{1,4})?$/.test(value);
}

function parseAmountGramScaled(value: string): bigint {
  if (!isAmountGram(value)) {
    throw new Error(`invalid_amount_gram:${value}`);
  }
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const whole = BigInt(wholeRaw);
  const fraction = BigInt((fractionRaw + "0000").slice(0, 4));
  return whole * AMOUNT_SCALE + fraction;
}

function formatAmountGram(value: bigint): string {
  const abs = value < 0n ? -value : value;
  const whole = abs / AMOUNT_SCALE;
  const fraction = abs % AMOUNT_SCALE;
  const formatted = `${whole.toString()}.${fraction.toString().padStart(4, "0")}`;
  return value < 0n ? `-${formatted}` : formatted;
}

function parseRunRequest(body: unknown): RunReconciliationRequest | null {
  if (body === undefined) return {};
  if (!isObject(body)) return null;
  if (body.inventoryTotalGram !== undefined && !isAmountGram(body.inventoryTotalGram)) return null;
  return {
    inventoryTotalGram: body.inventoryTotalGram,
  };
}

function parseLimit(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 100);
}

function parseManualUnfreezeRequest(body: unknown): ManualUnfreezeRequest | null {
  if (!isObject(body)) return null;
  if (typeof body.actor !== "string" || body.actor.trim() === "") return null;
  if (typeof body.reason !== "string" || body.reason.trim() === "") return null;
  return {
    actor: body.actor,
    reason: body.reason,
  };
}

function buildRun(
  certificates: SignedCertificate[],
  custodyTotalGram: string,
  thresholdGram: string,
): ReconciliationRun {
  let outstandingScaled = 0n;
  let activeCertificates = 0;
  let lockedCertificates = 0;

  for (const certificate of certificates) {
    if (certificate.payload.status === "ACTIVE") {
      activeCertificates += 1;
      outstandingScaled += parseAmountGramScaled(certificate.payload.amountGram);
    } else if (certificate.payload.status === "LOCKED") {
      lockedCertificates += 1;
      outstandingScaled += parseAmountGramScaled(certificate.payload.amountGram);
    }
  }

  const custodyScaled = parseAmountGramScaled(custodyTotalGram);
  const thresholdScaled = parseAmountGramScaled(thresholdGram);
  const mismatchScaled = outstandingScaled - custodyScaled;
  const absMismatchScaled = mismatchScaled < 0n ? -mismatchScaled : mismatchScaled;
  const freezeTriggered = absMismatchScaled >= thresholdScaled;
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "");

  return {
    runId: `RECON-${timestamp}-${randomUUID().split("-")[0]}`,
    createdAt,
    custodyTotalGram: formatAmountGram(custodyScaled),
    outstandingTotalGram: formatAmountGram(outstandingScaled),
    mismatchGram: formatAmountGram(mismatchScaled),
    absMismatchGram: formatAmountGram(absMismatchScaled),
    thresholdGram: formatAmountGram(thresholdScaled),
    freezeTriggered,
    certificatesEvaluated: certificates.length,
    activeCertificates,
    lockedCertificates,
  };
}

async function fetchCertificates(
  certificateServiceUrl: string,
  serviceAuthToken: string | undefined,
): Promise<SignedCertificate[]> {
  const authHeaders = buildServiceAuthHeaders(serviceAuthToken);
  const response = await fetch(`${certificateServiceUrl.replace(/\/$/, "")}/certificates`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`certificate_service_error:${response.status}`);
  }
  const json = (await response.json()) as ListCertificatesResponse;
  if (!Array.isArray(json.certificates)) {
    throw new Error("invalid_certificate_service_response");
  }
  return json.certificates;
}

async function publishReconciliationAlert(
  riskStreamUrl: string,
  run: ReconciliationRun,
  serviceAuthToken: string | undefined,
): Promise<void> {
  const payload: IngestReconciliationAlertRequest = {
    runId: run.runId,
    mismatchGram: run.mismatchGram,
    absMismatchGram: run.absMismatchGram,
    thresholdGram: run.thresholdGram,
    freezeTriggered: run.freezeTriggered,
    createdAt: run.createdAt,
  };
  const authHeaders = buildServiceAuthHeaders(serviceAuthToken);
  await fetch(`${riskStreamUrl.replace(/\/$/, "")}/ingest/reconciliation-alert`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
}

function freezeStateForRun(run: ReconciliationRun): FreezeState {
  return {
    active: run.freezeTriggered,
    reason: run.freezeTriggered
      ? `Mismatch ${run.absMismatchGram}g exceeded threshold ${run.thresholdGram}g`
      : undefined,
    updatedAt: run.createdAt,
    lastRunId: run.runId,
  };
}

interface BuildServerOptions {
  reconciliationStore?: ReconciliationStore;
  dbPath?: string;
  certificateServiceUrl?: string;
  riskStreamUrl?: string;
  custodyTotalGram?: string;
  mismatchThresholdGram?: string;
  serviceAuthToken?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const reconciliationStore =
    options.reconciliationStore ||
    new SqliteReconciliationStore(
      options.dbPath || process.env.RECON_DB_PATH || DEFAULT_RECON_DB_PATH,
    );
  const ownStore = !options.reconciliationStore;
  const certificateServiceUrl =
    options.certificateServiceUrl ||
    process.env.CERTIFICATE_SERVICE_URL ||
    DEFAULT_CERTIFICATE_SERVICE_URL;
  const riskStreamUrl = options.riskStreamUrl ?? process.env.RISK_STREAM_URL;
  const serviceAuthToken = options.serviceAuthToken ?? process.env.SERVICE_AUTH_TOKEN;
  const configuredCustodyTotalGram =
    options.custodyTotalGram || process.env.CUSTODY_TOTAL_GRAM || DEFAULT_CUSTODY_TOTAL_GRAM;
  const configuredMismatchThresholdGram =
    options.mismatchThresholdGram ||
    process.env.RECON_MISMATCH_THRESHOLD_GRAM ||
    DEFAULT_MISMATCH_THRESHOLD_GRAM;
  parseAmountGramScaled(configuredCustodyTotalGram);
  parseAmountGramScaled(configuredMismatchThresholdGram);

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

  app.get("/health", async () => ({ ok: true, service: "reconciliation-service" }));

  app.post("/reconcile/run", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const parsed = parseRunRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected optional { inventoryTotalGram }",
      });
    }

    const custodyTotalGram = parsed.inventoryTotalGram || configuredCustodyTotalGram;
    try {
      parseAmountGramScaled(custodyTotalGram);
    } catch {
      return reply.code(400).send({
        error: "invalid_inventory_total_gram",
      });
    }

    let certificates: SignedCertificate[];
    try {
      certificates = await fetchCertificates(certificateServiceUrl, serviceAuthToken);
    } catch (error) {
      return reply.code(502).send({
        error: "certificate_service_unavailable",
        message: error instanceof Error ? error.message : "failed_to_fetch_certificates",
      });
    }

    let run: ReconciliationRun;
    try {
      run = buildRun(certificates, custodyTotalGram, configuredMismatchThresholdGram);
    } catch (error) {
      return reply.code(500).send({
        error: "reconciliation_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }

    const freezeState = freezeStateForRun(run);
    reconciliationStore.insertRun(run);
    reconciliationStore.setFreezeState(freezeState);

    if (run.freezeTriggered && riskStreamUrl) {
      try {
        await publishReconciliationAlert(riskStreamUrl, run, serviceAuthToken);
      } catch {
        // Risk-stream publishing is best effort. Reconciliation result remains persisted.
      }
    }

    const response: RunReconciliationResponse = {
      run,
      freezeState,
    };
    return response;
  });

  app.get("/reconcile/latest", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const response: GetLatestReconciliationResponse = {
      run: reconciliationStore.getLatestRun(),
      freezeState: reconciliationStore.getFreezeState(),
    };
    return response;
  });

  app.get("/reconcile/history", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const query = req.query as { limit?: string };
    const limit = parseLimit(query.limit, DEFAULT_HISTORY_LIMIT);
    const response: ListReconciliationHistoryResponse = {
      runs: reconciliationStore.listRuns(limit),
    };
    return response;
  });

  app.post("/freeze/unfreeze", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const parsed = parseManualUnfreezeRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected actor and reason",
      });
    }

    const current = reconciliationStore.getFreezeState();
    if (!current.active) {
      return reply.code(409).send({
        error: "state_conflict",
        message: "Freeze state is already inactive",
      });
    }

    const createdAt = new Date().toISOString();
    const overrideRecord: FreezeOverrideRecord = {
      overrideId: `FOVR-${createdAt.replace(/[:.]/g, "")}-${randomUUID().split("-")[0]}`,
      action: "UNFREEZE",
      actor: parsed.actor,
      reason: parsed.reason,
      previousActive: true,
      nextActive: false,
      createdAt,
      runId: current.lastRunId,
    };

    const freezeState: FreezeState = {
      active: false,
      reason: `Manual unfreeze by ${parsed.actor}: ${parsed.reason}`,
      updatedAt: createdAt,
      lastRunId: current.lastRunId,
    };
    reconciliationStore.setFreezeState(freezeState);
    reconciliationStore.insertFreezeOverride(overrideRecord);

    const response: ManualUnfreezeResponse = {
      freezeState,
      override: overrideRecord,
    };
    return response;
  });

  app.get("/freeze/overrides", async (req, reply) => {
    if (!requireServiceAuth(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const query = req.query as { limit?: string };
    const limit = parseLimit(query.limit, DEFAULT_OVERRIDE_HISTORY_LIMIT);
    const response: ListFreezeOverridesResponse = {
      overrides: reconciliationStore.listFreezeOverrides(limit),
    };
    return response;
  });

  app.addHook("onClose", async () => {
    if (ownStore) {
      reconciliationStore.close();
    }
  });

  return app;
}
