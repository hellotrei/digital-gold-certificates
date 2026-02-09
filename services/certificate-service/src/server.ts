import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  canonicalJson,
  publicKeyFromPrivateKeyHex,
  sha256Hex,
  signHex,
  verifyHex,
  type IssueCertificateRequest,
  type IssueCertificateResponse,
  type SignedCertificate,
  type VerifyCertificateRequest,
  type VerifyCertificateResponse,
} from "@dgc/shared";

const DEFAULT_ISSUER_PRIVATE_KEY_HEX =
  "1f1e1d1c1b1a19181716151413121110ffeeddbbccaa99887766554433221100";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAmountGram(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d{1,4})?$/.test(value);
}

function isPurity(value: unknown): value is string {
  return typeof value === "string" && /^\d{3}\.\d$/.test(value);
}

function parseIssueRequest(body: unknown): IssueCertificateRequest | null {
  if (!isObject(body)) return null;
  if (!isNonEmptyString(body.owner)) return null;
  if (!isAmountGram(body.amountGram)) return null;
  if (!isPurity(body.purity)) return null;
  if (body.metadata !== undefined && !isObject(body.metadata)) return null;
  return {
    owner: body.owner,
    amountGram: body.amountGram,
    purity: body.purity,
    metadata: body.metadata,
  };
}

function parseVerifyRequest(body: unknown): VerifyCertificateRequest | null {
  if (!isObject(body)) return null;
  if (body.certId !== undefined && !isNonEmptyString(body.certId)) return null;
  if (body.certificate !== undefined && !isObject(body.certificate)) return null;
  return {
    certId: body.certId,
    certificate: body.certificate as SignedCertificate | undefined,
  };
}

function certIdNow(): string {
  return `DGC-${new Date().toISOString()}-${randomUUID().split("-")[0]}`;
}

export async function buildServer() {
  const app = Fastify({ logger: true });
  const certStore = new Map<string, SignedCertificate>();
  const issuerPrivateKeyHex =
    process.env.ISSUER_PRIVATE_KEY_HEX || DEFAULT_ISSUER_PRIVATE_KEY_HEX;
  const issuerPublicKeyHex = await publicKeyFromPrivateKeyHex(issuerPrivateKeyHex);

  app.get("/health", async () => ({ ok: true, service: "certificate-service" }));

  app.post("/certificates/issue", async (req, reply) => {
    const parsed = parseIssueRequest(req.body);
    if (!parsed) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Expected owner, amountGram, purity and optional metadata object",
      });
    }

    const payload = {
      certId: certIdNow(),
      issuer: issuerPublicKeyHex,
      owner: parsed.owner,
      amountGram: parsed.amountGram,
      purity: parsed.purity,
      issuedAt: new Date().toISOString(),
      status: "ACTIVE" as const,
      metadata: parsed.metadata,
    };
    const payloadHash = sha256Hex(canonicalJson(payload));
    const signature = await signHex(payloadHash, issuerPrivateKeyHex);

    const certificate: SignedCertificate = {
      payload,
      payloadHash,
      signature,
    };
    certStore.set(certificate.payload.certId, certificate);

    const response: IssueCertificateResponse = { certificate };
    return reply.code(201).send(response);
  });

  app.get("/certificates/:certId", async (req, reply) => {
    const params = req.params as { certId?: string };
    if (!isNonEmptyString(params.certId)) {
      return reply.code(400).send({ error: "invalid_cert_id" });
    }
    const certificate = certStore.get(params.certId);
    if (!certificate) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }
    return { certificate };
  });

  app.post("/certificates/verify", async (req, reply) => {
    const parsed = parseVerifyRequest(req.body);
    if (!parsed || (!parsed.certId && !parsed.certificate)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Provide certId or certificate",
      });
    }

    const certificate = parsed.certificate || certStore.get(parsed.certId || "");
    if (!certificate) {
      return reply.code(404).send({ error: "certificate_not_found" });
    }

    const recalculatedHash = sha256Hex(canonicalJson(certificate.payload));
    const hashMatches = recalculatedHash === certificate.payloadHash;

    let signatureValid = false;
    if (hashMatches) {
      try {
        signatureValid = await verifyHex(
          certificate.payloadHash,
          certificate.signature,
          certificate.payload.issuer,
        );
      } catch {
        signatureValid = false;
      }
    }

    const response: VerifyCertificateResponse = {
      certId: certificate.payload.certId,
      valid: hashMatches && signatureValid,
      hashMatches,
      signatureValid,
      status: certificate.payload.status,
    };

    return reply.send(response);
  });

  return app;
}
