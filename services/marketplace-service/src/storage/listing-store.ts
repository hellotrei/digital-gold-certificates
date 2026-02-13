import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ListingAuditEvent,
  ListingStatus,
  MarketplaceListing,
} from "@dgc/shared";

export interface ListListingsFilter {
  status?: ListingStatus;
}

export interface IdempotencyRecord {
  action: string;
  idempotencyKey: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  createdAt: string;
}

export interface ListingStore {
  putListing(listing: MarketplaceListing): void;
  getListing(listingId: string): MarketplaceListing | null;
  listListings(filter?: ListListingsFilter): MarketplaceListing[];
  appendAuditEvent(event: ListingAuditEvent): void;
  getAuditEvents(listingId: string): ListingAuditEvent[];
  getIdempotencyRecord(action: string, idempotencyKey: string): IdempotencyRecord | null;
  putIdempotencyRecord(record: IdempotencyRecord): void;
  close(): void;
}

interface ListingRow {
  listing_json: string;
}

interface AuditRow {
  event_json: string;
}

interface IdempotencyRow {
  action: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_json: string;
  created_at: string;
}

export class SqliteListingStore implements ListingStore {
  private readonly db: Database.Database;
  private readonly putListingStmt: Database.Statement<[string, string, string, string, string]>;
  private readonly getListingStmt: Database.Statement<[string], ListingRow>;
  private readonly listAllStmt: Database.Statement<[], ListingRow>;
  private readonly listByStatusStmt: Database.Statement<[string], ListingRow>;
  private readonly putAuditStmt: Database.Statement<[string, string, string, string | null, string, string]>;
  private readonly getAuditStmt: Database.Statement<[string], AuditRow>;
  private readonly getIdempotencyStmt: Database.Statement<[string, string], IdempotencyRow>;
  private readonly putIdempotencyStmt: Database.Statement<
    [string, string, string, number, string, string]
  >;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        listing_id TEXT PRIMARY KEY,
        cert_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        listing_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_listings_status_updated
      ON listings(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS listing_audit_events (
        event_id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_listing_audit_listing
      ON listing_audit_events(listing_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS listing_idempotency (
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(action, idempotency_key)
      );
    `);

    this.putListingStmt = this.db.prepare(`
      INSERT INTO listings (listing_id, cert_id, status, updated_at, listing_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(listing_id) DO UPDATE SET
        cert_id = excluded.cert_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        listing_json = excluded.listing_json
    `);

    this.getListingStmt = this.db.prepare(`
      SELECT listing_json
      FROM listings
      WHERE listing_id = ?
      LIMIT 1
    `) as Database.Statement<[string], ListingRow>;

    this.listAllStmt = this.db.prepare(`
      SELECT listing_json
      FROM listings
      ORDER BY updated_at DESC
    `) as Database.Statement<[], ListingRow>;

    this.listByStatusStmt = this.db.prepare(`
      SELECT listing_json
      FROM listings
      WHERE status = ?
      ORDER BY updated_at DESC
    `) as Database.Statement<[string], ListingRow>;

    this.putAuditStmt = this.db.prepare(`
      INSERT INTO listing_audit_events (event_id, listing_id, event_type, actor, occurred_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.getAuditStmt = this.db.prepare(`
      SELECT event_json
      FROM listing_audit_events
      WHERE listing_id = ?
      ORDER BY occurred_at ASC
    `) as Database.Statement<[string], AuditRow>;

    this.getIdempotencyStmt = this.db.prepare(`
      SELECT action, idempotency_key, request_hash, response_status, response_json, created_at
      FROM listing_idempotency
      WHERE action = ? AND idempotency_key = ?
      LIMIT 1
    `) as Database.Statement<[string, string], IdempotencyRow>;

    this.putIdempotencyStmt = this.db.prepare(`
      INSERT INTO listing_idempotency (action, idempotency_key, request_hash, response_status, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(action, idempotency_key) DO NOTHING
    `);
  }

  putListing(listing: MarketplaceListing): void {
    this.putListingStmt.run(
      listing.listingId,
      listing.certId,
      listing.status,
      listing.updatedAt,
      JSON.stringify(listing),
    );
  }

  getListing(listingId: string): MarketplaceListing | null {
    const row = this.getListingStmt.get(listingId);
    if (!row) return null;
    return JSON.parse(row.listing_json) as MarketplaceListing;
  }

  listListings(filter: ListListingsFilter = {}): MarketplaceListing[] {
    const rows =
      filter.status !== undefined
        ? this.listByStatusStmt.all(filter.status)
        : this.listAllStmt.all();
    return rows.map((row) => JSON.parse(row.listing_json) as MarketplaceListing);
  }

  appendAuditEvent(event: ListingAuditEvent): void {
    this.putAuditStmt.run(
      event.eventId,
      event.listingId,
      event.type,
      event.actor || null,
      event.occurredAt,
      JSON.stringify(event),
    );
  }

  getAuditEvents(listingId: string): ListingAuditEvent[] {
    const rows = this.getAuditStmt.all(listingId);
    return rows.map((row) => JSON.parse(row.event_json) as ListingAuditEvent);
  }

  getIdempotencyRecord(action: string, idempotencyKey: string): IdempotencyRecord | null {
    const row = this.getIdempotencyStmt.get(action, idempotencyKey);
    if (!row) return null;
    return {
      action: row.action,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: JSON.parse(row.response_json),
      createdAt: row.created_at,
    };
  }

  putIdempotencyRecord(record: IdempotencyRecord): void {
    this.putIdempotencyStmt.run(
      record.action,
      record.idempotencyKey,
      record.requestHash,
      record.responseStatus,
      JSON.stringify(record.responseBody),
      record.createdAt,
    );
  }

  close(): void {
    this.db.close();
  }
}
