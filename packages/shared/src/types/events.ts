export type LedgerEventType =
  | "ISSUED"
  | "TRANSFER"
  | "SPLIT"
  | "STATUS_CHANGED";

export interface LedgerEventBase {
  type: LedgerEventType;
  certId: string;
  occurredAt: string;   // ISO date
  proofHash?: string;   // optional: hash anchored on-chain
}

export interface IssuedEvent extends LedgerEventBase {
  type: "ISSUED";
  owner: string;
  amountGram: string;
  purity: string;
}

export interface TransferEvent extends LedgerEventBase {
  type: "TRANSFER";
  from: string;
  to: string;
  amountGram: string;
  price?: string;
}

export interface SplitEvent extends LedgerEventBase {
  type: "SPLIT";
  parentCertId: string;
  childCertId: string;
  from: string;
  to: string;
  amountChildGram: string;
}

export interface StatusChangedEvent extends LedgerEventBase {
  type: "STATUS_CHANGED";
  status: "ACTIVE" | "LOCKED" | "REDEEMED" | "REVOKED";
}

export type LedgerEvent = IssuedEvent | TransferEvent | SplitEvent | StatusChangedEvent;
