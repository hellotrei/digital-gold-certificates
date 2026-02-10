import type { SignedCertificate } from "./certificate.js";

export interface ProofAnchorRecord {
  certId: string;
  payloadHash: string;
  proofHash: string;
  anchoredAt: string;
  ledgerTxRef?: string;
}

export interface AnchorProofRequest {
  certId: string;
  payloadHash: string;
  occurredAt: string;
}

export interface AnchorProofResponse {
  proof: ProofAnchorRecord;
}

export interface IssueCertificateRequest {
  owner: string;
  amountGram: string;
  purity: string;
  metadata?: Record<string, unknown>;
}

export interface IssueCertificateResponse {
  certificate: SignedCertificate;
  proof?: ProofAnchorRecord;
  proofAnchorStatus: "ANCHORED" | "SKIPPED" | "FAILED";
}

export interface VerifyCertificateRequest {
  certId?: string;
  certificate?: SignedCertificate;
}

export interface VerifyCertificateResponse {
  certId: string;
  valid: boolean;
  hashMatches: boolean;
  signatureValid: boolean;
  status: string;
}
