import type { CertificateStatus, SignedCertificate } from "./certificate.js";
import type { LedgerEvent } from "./events.js";

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
  eventWriteStatus: "RECORDED" | "SKIPPED" | "FAILED";
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

export interface TransferCertificateRequest {
  certId: string;
  toOwner: string;
  price?: string;
}

export interface TransferCertificateResponse {
  certificate: SignedCertificate;
  proofAnchorStatus: "ANCHORED" | "SKIPPED" | "FAILED";
  proof?: ProofAnchorRecord;
  eventWriteStatus: "RECORDED" | "SKIPPED" | "FAILED";
}

export interface SplitCertificateRequest {
  parentCertId: string;
  toOwner: string;
  amountChildGram: string;
  price?: string;
}

export interface SplitCertificateResponse {
  parentCertificate: SignedCertificate;
  childCertificate: SignedCertificate;
  proofAnchorStatus: "ANCHORED" | "SKIPPED" | "FAILED";
  childProof?: ProofAnchorRecord;
  parentProof?: ProofAnchorRecord;
  eventWriteStatus: "RECORDED" | "SKIPPED" | "FAILED";
}

export interface ChangeCertificateStatusRequest {
  certId: string;
  status: CertificateStatus;
}

export interface ChangeCertificateStatusResponse {
  certificate: SignedCertificate;
  proofAnchorStatus: "ANCHORED" | "SKIPPED" | "FAILED";
  proof?: ProofAnchorRecord;
  eventWriteStatus: "RECORDED" | "SKIPPED" | "FAILED";
}

export interface RecordLedgerEventRequest {
  event: LedgerEvent;
}

export interface RecordLedgerEventResponse {
  event: LedgerEvent;
  eventHash: string;
}

export interface GetTimelineResponse {
  certId: string;
  events: LedgerEvent[];
}
