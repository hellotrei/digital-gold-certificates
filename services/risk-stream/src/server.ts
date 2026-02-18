import Fastify from "fastify";
import type {
  CertificateRiskProfile,
  GetCertificateRiskResponse,
  GetListingRiskResponse,
  GetRiskAlertsResponse,
  IngestLedgerEventRequest,
  IngestLedgerEventResponse,
  IngestListingAuditEventRequest,
  IngestListingAuditEventResponse,
  LedgerEvent,
  ListingAuditEvent,
  ListingRiskProfile,
  RiskAlert,
  RiskLevel,
  RiskReason,
  RiskSummaryResponse,
} from "@dgc/shared";
import { SqliteRiskStore, type RiskStore } from "./storage/risk-store.js";

const DEFAULT_RISK_DB_PATH = "data/risk-stream.db";
const DEFAULT_ALERT_THRESHOLD = 60;
const DEFAULT_SUMMARY_LIMIT = 5;
const DEFAULT_ALERT_LIMIT = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIsoDate(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (!isObject(value)) return false;
  if (!isNonEmptyString(value.certId) || !isValidIsoDate(value.occurredAt)) return false;
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
    return (
      value.status === "ACTIVE" ||
      value.status === "LOCKED" ||
      value.status === "REDEEMED" ||
      value.status === "REVOKED"
    );
  }
  return false;
}

function isListingAuditEvent(value: unknown): value is ListingAuditEvent {
  if (!isObject(value)) return false;
  if (!isNonEmptyString(value.eventId)) return false;
  if (!isNonEmptyString(value.listingId)) return false;
  if (!isValidIsoDate(value.occurredAt)) return false;
  if (
    value.type !== "CREATED" &&
    value.type !== "LOCKED" &&
    value.type !== "SETTLED" &&
    value.type !== "CANCELLED"
  ) {
    return false;
  }
  if (value.actor !== undefined && !isNonEmptyString(value.actor)) return false;
  if (value.details !== undefined && !isObject(value.details)) return false;
  return true;
}

function parseIngestLedgerRequest(body: unknown): IngestLedgerEventRequest | null {
  if (!isObject(body) || !isLedgerEvent(body.event)) return null;
  return { event: body.event };
}

function parseIngestListingRequest(body: unknown): IngestListingAuditEventRequest | null {
  if (!isObject(body) || !isListingAuditEvent(body.event)) return null;
  if (body.listing !== undefined) {
    if (!isObject(body.listing)) return null;
    if (!isNonEmptyString(body.listing.listingId)) return null;
    if (!isNonEmptyString(body.listing.certId)) return null;
  }
  return {
    event: body.event,
    listing: body.listing as IngestListingAuditEventRequest["listing"] | undefined,
  };
}

function toMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLimitParam(value: unknown, fallback: number): number {
  if (!isNonEmptyString(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 50);
}

function computeRiskLevel(score: number): RiskLevel {
  if (score >= 60) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

function normalizeScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildCertificateRiskProfile(
  certId: string,
  ledgerEvents: LedgerEvent[],
  listingEvents: Array<{ event: ListingAuditEvent; certId?: string }>,
): CertificateRiskProfile {
  const nowMs = Date.now();
  const reasons: RiskReason[] = [];
  const transferEvents = ledgerEvents.filter(
    (event): event is Extract<LedgerEvent, { type: "TRANSFER" }> => event.type === "TRANSFER",
  );

  const transfer24hCount = transferEvents.filter(
    (event) => nowMs - toMs(event.occurredAt) <= 24 * 60 * 60 * 1000,
  ).length;
  if (transfer24hCount >= 5) {
    reasons.push({
      code: "TRANSFER_VELOCITY_CRITICAL",
      scoreImpact: 40,
      message: "Certificate transfer velocity is critically high in the last 24h",
      evidence: { transfer24hCount },
    });
  } else if (transfer24hCount >= 3) {
    reasons.push({
      code: "TRANSFER_VELOCITY_ELEVATED",
      scoreImpact: 25,
      message: "Certificate transfer velocity is elevated in the last 24h",
      evidence: { transfer24hCount },
    });
  }

  const transfer48h = transferEvents
    .filter((event) => nowMs - toMs(event.occurredAt) <= 48 * 60 * 60 * 1000)
    .sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  let washLoopFound = false;
  for (let i = 0; i < transfer48h.length && !washLoopFound; i += 1) {
    for (let j = i + 1; j < transfer48h.length; j += 1) {
      const first = transfer48h[i];
      const second = transfer48h[j];
      if (toMs(second.occurredAt) - toMs(first.occurredAt) > 48 * 60 * 60 * 1000) break;
      if (first.from === second.to && first.to === second.from) {
        washLoopFound = true;
        reasons.push({
          code: "WASH_LOOP_PATTERN",
          scoreImpact: 30,
          message: "Detected back-and-forth transfer loop in short window",
          evidence: {
            from: first.from,
            to: first.to,
            firstTransferAt: first.occurredAt,
            reverseTransferAt: second.occurredAt,
          },
        });
        break;
      }
    }
  }

  const cancellation7dCount = listingEvents.filter(
    ({ event }) =>
      event.type === "CANCELLED" && nowMs - toMs(event.occurredAt) <= 7 * 24 * 60 * 60 * 1000,
  ).length;
  if (cancellation7dCount >= 4) {
    reasons.push({
      code: "CANCELLATION_PRESSURE_CRITICAL",
      scoreImpact: 35,
      message: "Certificate is associated with high cancellation pressure in 7d",
      evidence: { cancellation7dCount },
    });
  } else if (cancellation7dCount >= 2) {
    reasons.push({
      code: "CANCELLATION_PRESSURE_ELEVATED",
      scoreImpact: 20,
      message: "Certificate is associated with repeated cancellations in 7d",
      evidence: { cancellation7dCount },
    });
  }

  const score = normalizeScore(reasons.reduce((sum, reason) => sum + reason.scoreImpact, 0));
  return {
    certId,
    score,
    level: computeRiskLevel(score),
    reasons,
    updatedAt: new Date().toISOString(),
  };
}

function buildListingRiskProfile(
  listingId: string,
  certId: string | undefined,
  listingEvents: Array<{ event: ListingAuditEvent; certId?: string }>,
  actorEventsLookup: (actor: string) => Array<{ event: ListingAuditEvent; certId?: string }>,
): ListingRiskProfile {
  const nowMs = Date.now();
  const reasons: RiskReason[] = [];
  const events = listingEvents.map((entry) => entry.event);

  const lockCount = events.filter((event) => event.type === "LOCKED").length;
  const cancelCount = events.filter((event) => event.type === "CANCELLED").length;
  if (lockCount > 0 && cancelCount > 0) {
    reasons.push({
      code: "LOCK_CANCEL_PATTERN",
      scoreImpact: 35,
      message: "Listing shows lock-cancel churn pattern",
      evidence: { lockCount, cancelCount },
    });
  }

  if (lockCount >= 2) {
    reasons.push({
      code: "MULTIPLE_LOCK_ATTEMPTS",
      scoreImpact: 15,
      message: "Listing has multiple lock attempts",
      evidence: { lockCount },
    });
  }

  const latestCancel = events
    .filter((event): event is ListingAuditEvent & { type: "CANCELLED" } => event.type === "CANCELLED")
    .sort((a, b) => toMs(b.occurredAt) - toMs(a.occurredAt))[0];

  if (latestCancel?.details && isNonEmptyString(latestCancel.details.reason)) {
    if (latestCancel.details.reason === "buyer_timeout") {
      reasons.push({
        code: "BUYER_TIMEOUT_SIGNAL",
        scoreImpact: 10,
        message: "Listing cancelled due to buyer timeout",
      });
    }
  }

  if (latestCancel?.actor) {
    const actorCancel7dCount = actorEventsLookup(latestCancel.actor).filter(
      ({ event }) =>
        event.type === "CANCELLED" &&
        nowMs - toMs(event.occurredAt) <= 7 * 24 * 60 * 60 * 1000,
    ).length;
    if (actorCancel7dCount >= 3) {
      reasons.push({
        code: "ACTOR_REPEAT_CANCELLATION",
        scoreImpact: 30,
        message: "Actor shows repeated cancellation behavior in 7d window",
        evidence: { actor: latestCancel.actor, actorCancel7dCount },
      });
    }
  }

  const score = normalizeScore(reasons.reduce((sum, reason) => sum + reason.scoreImpact, 0));
  return {
    listingId,
    certId,
    score,
    level: computeRiskLevel(score),
    reasons,
    updatedAt: new Date().toISOString(),
  };
}

async function publishAlert(
  alert: RiskAlert,
  webhookUrl: string | undefined,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort webhook delivery.
  }
}

async function maybeEmitAlert(
  riskStore: RiskStore,
  alert: RiskAlert,
  previousScore: number | null,
  threshold: number,
  webhookUrl: string | undefined,
): Promise<void> {
  if (alert.score < threshold) return;
  if (previousScore !== null && previousScore >= threshold) return;
  riskStore.insertAlert(alert);
  await publishAlert(alert, webhookUrl);
}

async function recalculateCertificateProfile(
  riskStore: RiskStore,
  certId: string,
  threshold: number,
  webhookUrl: string | undefined,
): Promise<CertificateRiskProfile> {
  const previous = riskStore.getCertificateProfile(certId);
  const profile = buildCertificateRiskProfile(
    certId,
    riskStore.getLedgerEventsByCert(certId),
    riskStore.getListingAuditEventsByCert(certId),
  );
  riskStore.upsertCertificateProfile(profile);
  const alert: RiskAlert = {
    alertId: `ALERT-CERT-${certId}-${profile.updatedAt}`,
    targetType: "CERTIFICATE",
    targetId: certId,
    score: profile.score,
    level: profile.level,
    reasons: profile.reasons,
    createdAt: profile.updatedAt,
  };
  await maybeEmitAlert(riskStore, alert, previous?.score ?? null, threshold, webhookUrl);
  return profile;
}

async function recalculateListingProfile(
  riskStore: RiskStore,
  listingId: string,
  threshold: number,
  webhookUrl: string | undefined,
): Promise<ListingRiskProfile | null> {
  const previous = riskStore.getListingProfile(listingId);
  const listingEvents = riskStore.getListingAuditEventsByListing(listingId);
  if (listingEvents.length === 0) return null;
  const certId =
    listingEvents.find((entry) => entry.certId !== undefined)?.certId ||
    riskStore.getListingCertId(listingId);

  const profile = buildListingRiskProfile(
    listingId,
    certId,
    listingEvents,
    (actor) => riskStore.getListingAuditEventsByActor(actor),
  );
  riskStore.upsertListingProfile(profile);

  const alert: RiskAlert = {
    alertId: `ALERT-LIST-${listingId}-${profile.updatedAt}`,
    targetType: "LISTING",
    targetId: listingId,
    score: profile.score,
    level: profile.level,
    reasons: profile.reasons,
    createdAt: profile.updatedAt,
  };
  await maybeEmitAlert(riskStore, alert, previous?.score ?? null, threshold, webhookUrl);

  if (certId) {
    await recalculateCertificateProfile(riskStore, certId, threshold, webhookUrl);
  }
  return profile;
}

interface BuildServerOptions {
  riskStore?: RiskStore;
  dbPath?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const riskStore =
    options.riskStore ||
    new SqliteRiskStore(options.dbPath || process.env.RISK_DB_PATH || DEFAULT_RISK_DB_PATH);
  const ownRiskStore = !options.riskStore;
  const alertThresholdRaw = Number(process.env.RISK_ALERT_THRESHOLD || DEFAULT_ALERT_THRESHOLD);
  const alertThreshold = Number.isFinite(alertThresholdRaw)
    ? Math.max(0, Math.min(100, alertThresholdRaw))
    : DEFAULT_ALERT_THRESHOLD;
  const alertWebhookUrl = process.env.RISK_ALERT_WEBHOOK_URL;

  app.get("/health", async () => ({ ok: true, service: "risk-stream" }));

  app.post("/ingest/ledger-event", async (req, reply) => {
    const parsed = parseIngestLedgerRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected { event: LedgerEvent } payload",
      });
    }

    riskStore.appendLedgerEvent(parsed.event);
    await recalculateCertificateProfile(
      riskStore,
      parsed.event.certId,
      alertThreshold,
      alertWebhookUrl,
    );
    const response: IngestLedgerEventResponse = {
      accepted: true,
      certId: parsed.event.certId,
    };
    return reply.code(202).send(response);
  });

  app.post("/ingest/listing-audit-event", async (req, reply) => {
    const parsed = parseIngestListingRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected { event: ListingAuditEvent, listing?: MarketplaceListing } payload",
      });
    }

    const certId = parsed.listing?.certId || riskStore.getListingCertId(parsed.event.listingId);
    riskStore.appendListingAuditEvent(parsed.event, certId);
    await recalculateListingProfile(
      riskStore,
      parsed.event.listingId,
      alertThreshold,
      alertWebhookUrl,
    );

    const response: IngestListingAuditEventResponse = {
      accepted: true,
      listingId: parsed.event.listingId,
    };
    return reply.code(202).send(response);
  });

  app.get("/risk/certificates/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }

    const profile = riskStore.getCertificateProfile(params.certId);
    if (!profile) {
      return reply.code(404).send({ error: "certificate_risk_not_found" });
    }

    const response: GetCertificateRiskResponse = { profile };
    return response;
  });

  app.get("/risk/listings/:listingId", async (req, reply) => {
    const params = req.params as { listingId?: string };
    if (!isNonEmptyString(params.listingId)) {
      return reply.code(400).send({ error: "invalid_listing_id" });
    }

    const profile = riskStore.getListingProfile(params.listingId);
    if (!profile) {
      return reply.code(404).send({ error: "listing_risk_not_found" });
    }

    const response: GetListingRiskResponse = { profile };
    return response;
  });

  app.get("/risk/summary", async (req) => {
    const query = req.query as { limit?: string };
    const limit = parseLimitParam(query.limit, DEFAULT_SUMMARY_LIMIT);
    const response: RiskSummaryResponse = {
      topCertificates: riskStore.listTopCertificates(limit),
      topListings: riskStore.listTopListings(limit),
      updatedAt: new Date().toISOString(),
    };
    return response;
  });

  app.get("/risk/alerts", async (req) => {
    const query = req.query as { limit?: string };
    const limit = parseLimitParam(query.limit, DEFAULT_ALERT_LIMIT);
    const response: GetRiskAlertsResponse = {
      alerts: riskStore.listAlerts(limit),
    };
    return response;
  });

  app.addHook("onClose", async () => {
    if (ownRiskStore) {
      riskStore.close();
    }
  });

  return app;
}
