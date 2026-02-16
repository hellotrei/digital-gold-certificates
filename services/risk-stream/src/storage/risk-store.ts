import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  CertificateRiskProfile,
  LedgerEvent,
  ListingAuditEvent,
  ListingRiskProfile,
} from "@dgc/shared";

interface LedgerRow {
  event_json: string;
}

interface ListingAuditRow {
  event_json: string;
  cert_id: string | null;
}

interface CertProfileRow {
  profile_json: string;
}

interface ListingProfileRow {
  profile_json: string;
}

interface CertIdRow {
  cert_id: string | null;
}

export interface RiskStore {
  appendLedgerEvent(event: LedgerEvent): void;
  appendListingAuditEvent(event: ListingAuditEvent, certId?: string): void;
  getListingCertId(listingId: string): string | undefined;
  getLedgerEventsByCert(certId: string): LedgerEvent[];
  getListingAuditEventsByListing(listingId: string): Array<{ event: ListingAuditEvent; certId?: string }>;
  getListingAuditEventsByCert(certId: string): Array<{ event: ListingAuditEvent; certId?: string }>;
  getListingAuditEventsByActor(actor: string): Array<{ event: ListingAuditEvent; certId?: string }>;
  upsertCertificateProfile(profile: CertificateRiskProfile): void;
  upsertListingProfile(profile: ListingRiskProfile): void;
  getCertificateProfile(certId: string): CertificateRiskProfile | null;
  getListingProfile(listingId: string): ListingRiskProfile | null;
  close(): void;
}

export class SqliteRiskStore implements RiskStore {
  private readonly db: Database.Database;
  private readonly insertLedgerEventStmt: Database.Statement<[string, string, string]>;
  private readonly insertListingAuditStmt: Database.Statement<
    [string, string, string | null, string | null, string, string]
  >;
  private readonly getListingCertIdStmt: Database.Statement<[string], CertIdRow>;
  private readonly getLedgerByCertStmt: Database.Statement<[string], LedgerRow>;
  private readonly getListingByListingStmt: Database.Statement<[string], ListingAuditRow>;
  private readonly getListingByCertStmt: Database.Statement<[string], ListingAuditRow>;
  private readonly getListingByActorStmt: Database.Statement<[string], ListingAuditRow>;
  private readonly upsertCertProfileStmt: Database.Statement<[string, number, string, string, string]>;
  private readonly upsertListingProfileStmt: Database.Statement<[string, string | null, number, string, string, string]>;
  private readonly getCertProfileStmt: Database.Statement<[string], CertProfileRow>;
  private readonly getListingProfileStmt: Database.Statement<[string], ListingProfileRow>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cert_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_risk_ledger_cert_time
      ON risk_ledger_events(cert_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS risk_listing_audit_events (
        event_id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL,
        cert_id TEXT,
        actor TEXT,
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_risk_listing_listing_time
      ON risk_listing_audit_events(listing_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_risk_listing_cert_time
      ON risk_listing_audit_events(cert_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_risk_listing_actor_time
      ON risk_listing_audit_events(actor, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS risk_certificate_profiles (
        cert_id TEXT PRIMARY KEY,
        score INTEGER NOT NULL,
        level TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        profile_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_listing_profiles (
        listing_id TEXT PRIMARY KEY,
        cert_id TEXT,
        score INTEGER NOT NULL,
        level TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        profile_json TEXT NOT NULL
      );
    `);

    this.insertLedgerEventStmt = this.db.prepare(`
      INSERT INTO risk_ledger_events (cert_id, occurred_at, event_json)
      VALUES (?, ?, ?)
    `);

    this.insertListingAuditStmt = this.db.prepare(`
      INSERT INTO risk_listing_audit_events (event_id, listing_id, cert_id, actor, occurred_at, event_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);

    this.getListingCertIdStmt = this.db.prepare(`
      SELECT cert_id
      FROM risk_listing_audit_events
      WHERE listing_id = ? AND cert_id IS NOT NULL
      ORDER BY occurred_at DESC
      LIMIT 1
    `) as Database.Statement<[string], CertIdRow>;

    this.getLedgerByCertStmt = this.db.prepare(`
      SELECT event_json
      FROM risk_ledger_events
      WHERE cert_id = ?
      ORDER BY occurred_at DESC
    `) as Database.Statement<[string], LedgerRow>;

    this.getListingByListingStmt = this.db.prepare(`
      SELECT event_json, cert_id
      FROM risk_listing_audit_events
      WHERE listing_id = ?
      ORDER BY occurred_at DESC
    `) as Database.Statement<[string], ListingAuditRow>;

    this.getListingByCertStmt = this.db.prepare(`
      SELECT event_json, cert_id
      FROM risk_listing_audit_events
      WHERE cert_id = ?
      ORDER BY occurred_at DESC
    `) as Database.Statement<[string], ListingAuditRow>;

    this.getListingByActorStmt = this.db.prepare(`
      SELECT event_json, cert_id
      FROM risk_listing_audit_events
      WHERE actor = ?
      ORDER BY occurred_at DESC
    `) as Database.Statement<[string], ListingAuditRow>;

    this.upsertCertProfileStmt = this.db.prepare(`
      INSERT INTO risk_certificate_profiles (cert_id, score, level, updated_at, profile_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cert_id) DO UPDATE SET
        score = excluded.score,
        level = excluded.level,
        updated_at = excluded.updated_at,
        profile_json = excluded.profile_json
    `);

    this.upsertListingProfileStmt = this.db.prepare(`
      INSERT INTO risk_listing_profiles (listing_id, cert_id, score, level, updated_at, profile_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(listing_id) DO UPDATE SET
        cert_id = excluded.cert_id,
        score = excluded.score,
        level = excluded.level,
        updated_at = excluded.updated_at,
        profile_json = excluded.profile_json
    `);

    this.getCertProfileStmt = this.db.prepare(`
      SELECT profile_json
      FROM risk_certificate_profiles
      WHERE cert_id = ?
      LIMIT 1
    `) as Database.Statement<[string], CertProfileRow>;

    this.getListingProfileStmt = this.db.prepare(`
      SELECT profile_json
      FROM risk_listing_profiles
      WHERE listing_id = ?
      LIMIT 1
    `) as Database.Statement<[string], ListingProfileRow>;
  }

  appendLedgerEvent(event: LedgerEvent): void {
    this.insertLedgerEventStmt.run(event.certId, event.occurredAt, JSON.stringify(event));
  }

  appendListingAuditEvent(event: ListingAuditEvent, certId?: string): void {
    this.insertListingAuditStmt.run(
      event.eventId,
      event.listingId,
      certId || null,
      event.actor || null,
      event.occurredAt,
      JSON.stringify(event),
    );
  }

  getListingCertId(listingId: string): string | undefined {
    const row = this.getListingCertIdStmt.get(listingId);
    return row?.cert_id || undefined;
  }

  getLedgerEventsByCert(certId: string): LedgerEvent[] {
    const rows = this.getLedgerByCertStmt.all(certId);
    return rows.map((row) => JSON.parse(row.event_json) as LedgerEvent);
  }

  getListingAuditEventsByListing(listingId: string): Array<{ event: ListingAuditEvent; certId?: string }> {
    const rows = this.getListingByListingStmt.all(listingId);
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as ListingAuditEvent,
      certId: row.cert_id || undefined,
    }));
  }

  getListingAuditEventsByCert(certId: string): Array<{ event: ListingAuditEvent; certId?: string }> {
    const rows = this.getListingByCertStmt.all(certId);
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as ListingAuditEvent,
      certId: row.cert_id || undefined,
    }));
  }

  getListingAuditEventsByActor(actor: string): Array<{ event: ListingAuditEvent; certId?: string }> {
    const rows = this.getListingByActorStmt.all(actor);
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as ListingAuditEvent,
      certId: row.cert_id || undefined,
    }));
  }

  upsertCertificateProfile(profile: CertificateRiskProfile): void {
    this.upsertCertProfileStmt.run(
      profile.certId,
      profile.score,
      profile.level,
      profile.updatedAt,
      JSON.stringify(profile),
    );
  }

  upsertListingProfile(profile: ListingRiskProfile): void {
    this.upsertListingProfileStmt.run(
      profile.listingId,
      profile.certId || null,
      profile.score,
      profile.level,
      profile.updatedAt,
      JSON.stringify(profile),
    );
  }

  getCertificateProfile(certId: string): CertificateRiskProfile | null {
    const row = this.getCertProfileStmt.get(certId);
    if (!row) return null;
    return JSON.parse(row.profile_json) as CertificateRiskProfile;
  }

  getListingProfile(listingId: string): ListingRiskProfile | null {
    const row = this.getListingProfileStmt.get(listingId);
    if (!row) return null;
    return JSON.parse(row.profile_json) as ListingRiskProfile;
  }

  close(): void {
    this.db.close();
  }
}
