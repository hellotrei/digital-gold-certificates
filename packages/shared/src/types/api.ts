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

export type ListingStatus = "OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
export type ListingAuditEventType = "CREATED" | "LOCKED" | "SETTLED" | "CANCELLED";

export interface MarketplaceListing {
  listingId: string;
  certId: string;
  seller: string;
  askPrice: string;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
  lockedBy?: string;
  lockedAt?: string;
  settledAt?: string;
  settledPrice?: string;
  cancelledAt?: string;
  cancelReason?: string;
}

export interface ListingAuditEvent {
  eventId: string;
  listingId: string;
  type: ListingAuditEventType;
  actor?: string;
  occurredAt: string;
  details?: Record<string, unknown>;
}

export interface CreateListingRequest {
  certId: string;
  seller: string;
  askPrice: string;
}

export interface CreateListingResponse {
  listing: MarketplaceListing;
}

export interface GetListingResponse {
  listing: MarketplaceListing;
}

export interface ListListingsResponse {
  listings: MarketplaceListing[];
}

export interface GetListingAuditResponse {
  listingId: string;
  events: ListingAuditEvent[];
}

export interface LockEscrowRequest {
  listingId: string;
  buyer: string;
}

export interface LockEscrowResponse {
  listing: MarketplaceListing;
}

export interface SettleEscrowRequest {
  listingId: string;
  buyer: string;
  settledPrice?: string;
}

export interface SettleEscrowResponse {
  listing: MarketplaceListing;
  transfer: TransferCertificateResponse;
}

export interface CancelEscrowRequest {
  listingId: string;
  reason?: string;
}

export interface CancelEscrowResponse {
  listing: MarketplaceListing;
}

export interface RecordLedgerEventRequest {
  event: LedgerEvent;
}

export interface RecordLedgerEventResponse {
  event: LedgerEvent;
  eventHash: string;
  ledgerTxRef?: string;
}

export interface GetTimelineResponse {
  certId: string;
  events: LedgerEvent[];
}
