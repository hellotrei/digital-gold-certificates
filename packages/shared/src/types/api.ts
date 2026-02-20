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

export interface GetCertificateResponse {
  certificate: SignedCertificate;
}

export interface ListCertificatesResponse {
  certificates: SignedCertificate[];
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
export type ListingAuditEventType =
  | "CREATED"
  | "LOCKED"
  | "SETTLED"
  | "CANCELLED"
  | "DISPUTE_OPENED";

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
  underDispute?: boolean;
  disputeId?: string;
  disputeStatus?: "OPEN" | "ASSIGNED" | "RESOLVED";
  disputeOpenedAt?: string;
  disputeResolvedAt?: string;
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

export interface OpenListingDisputeRequest {
  openedBy: string;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface OpenListingDisputeResponse {
  listing: MarketplaceListing;
  dispute: DisputeRecord;
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

export interface RiskReason {
  code: string;
  scoreImpact: number;
  message: string;
  evidence?: Record<string, unknown>;
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface CertificateRiskProfile {
  certId: string;
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  updatedAt: string;
}

export interface ListingRiskProfile {
  listingId: string;
  certId?: string;
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  updatedAt: string;
}

export type RiskAlertTarget = "CERTIFICATE" | "LISTING" | "RECONCILIATION";

export interface RiskAlert {
  alertId: string;
  targetType: RiskAlertTarget;
  targetId: string;
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
  createdAt: string;
}

export interface IngestLedgerEventRequest {
  event: LedgerEvent;
}

export interface IngestLedgerEventResponse {
  accepted: true;
  certId: string;
}

export interface IngestListingAuditEventRequest {
  event: ListingAuditEvent;
  listing?: MarketplaceListing;
}

export interface IngestListingAuditEventResponse {
  accepted: true;
  listingId: string;
}

export interface GetCertificateRiskResponse {
  profile: CertificateRiskProfile;
}

export interface GetListingRiskResponse {
  profile: ListingRiskProfile;
}

export interface RiskSummaryResponse {
  topCertificates: CertificateRiskProfile[];
  topListings: ListingRiskProfile[];
  updatedAt: string;
}

export interface GetRiskAlertsResponse {
  alerts: RiskAlert[];
}

export interface ReconciliationRun {
  runId: string;
  createdAt: string;
  custodyTotalGram: string;
  outstandingTotalGram: string;
  mismatchGram: string;
  absMismatchGram: string;
  thresholdGram: string;
  freezeTriggered: boolean;
  certificatesEvaluated: number;
  activeCertificates: number;
  lockedCertificates: number;
}

export interface FreezeState {
  active: boolean;
  reason?: string;
  updatedAt: string;
  lastRunId?: string;
}

export interface RunReconciliationRequest {
  inventoryTotalGram?: string;
}

export interface RunReconciliationResponse {
  run: ReconciliationRun;
  freezeState: FreezeState;
}

export interface GetLatestReconciliationResponse {
  run: ReconciliationRun | null;
  freezeState: FreezeState;
}

export interface ListReconciliationHistoryResponse {
  runs: ReconciliationRun[];
}

export interface IngestReconciliationAlertRequest {
  runId: string;
  mismatchGram: string;
  absMismatchGram: string;
  thresholdGram: string;
  freezeTriggered: boolean;
  createdAt: string;
}

export interface IngestReconciliationAlertResponse {
  accepted: true;
  alertId: string;
}

export type DisputeStatus = "OPEN" | "ASSIGNED" | "RESOLVED";
export type DisputeResolution = "REFUND_BUYER" | "RELEASE_SELLER" | "MANUAL_REVIEW";

export interface DisputeRecord {
  disputeId: string;
  listingId: string;
  certId: string;
  status: DisputeStatus;
  openedBy: string;
  reason: string;
  evidence?: Record<string, unknown>;
  openedAt: string;
  assignedTo?: string;
  assignedAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolution?: DisputeResolution;
  resolutionNotes?: string;
}

export interface OpenDisputeRequest {
  listingId: string;
  certId: string;
  openedBy: string;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface OpenDisputeResponse {
  dispute: DisputeRecord;
}

export interface AssignDisputeRequest {
  assignee: string;
}

export interface AssignDisputeResponse {
  dispute: DisputeRecord;
}

export interface ResolveDisputeRequest {
  resolvedBy: string;
  resolution: DisputeResolution;
  resolutionNotes?: string;
}

export interface ResolveDisputeResponse {
  dispute: DisputeRecord;
}

export interface GetDisputeResponse {
  dispute: DisputeRecord;
}

export interface ListDisputesResponse {
  disputes: DisputeRecord[];
}
