type SearchParams = Promise<{ certId?: string; listingId?: string }>;

type ApiResult<T> = {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
};

type RiskProfileSummary = {
  score: number;
  level: string;
  reasons: Array<{ code: string; message?: string }>;
};

type RiskSummaryResponse = {
  topCertificates: Array<{ certId: string; score: number; level: string }>;
  topListings: Array<{ listingId: string; certId?: string; score: number; level: string }>;
  updatedAt: string;
};

type RiskAlert = {
  alertId: string;
  targetType: string;
  targetId: string;
  score: number;
  level: string;
  reasons: Array<{ code: string; message?: string }>;
  createdAt: string;
};

type LatestReconciliationResponse = {
  run: {
    runId: string;
    createdAt: string;
    custodyTotalGram: string;
    outstandingTotalGram: string;
    mismatchGram: string;
    absMismatchGram: string;
    thresholdGram: string;
    freezeTriggered: boolean;
  } | null;
  freezeState: {
    active: boolean;
    reason?: string;
    updatedAt: string;
    lastRunId?: string;
  };
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : undefined;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error: text || response.statusText,
      };
    }
    return {
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

function RiskCard({
  title,
  result,
}: {
  title: string;
  result: ApiResult<{ profile: RiskProfileSummary }> | null;
}) {
  if (!result) {
    return null;
  }
  if (!result.ok) {
    return (
      <pre
        style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
      >
        {JSON.stringify(result, null, 2)}
      </pre>
    );
  }
  const profile = result.data?.profile;
  if (!profile) {
    return <p>No risk profile available.</p>;
  }
  return (
    <section>
      <h2 style={{ marginBottom: 8 }}>{title}</h2>
      <div
        style={{
          padding: 12,
          background: "#f6f6f6",
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div>
          <strong>Score:</strong> {profile.score} <strong>Level:</strong> {profile.level}
        </div>
        <div>
          <strong>Reasons:</strong>{" "}
          {profile.reasons.length === 0
            ? "None"
            : profile.reasons.map((reason) => reason.code).join(",")}
        </div>
      </div>
      {profile.reasons.length > 0 && (
        <ul style={{ marginTop: 8 }}>
          {profile.reasons.map((reason) => (
            <li key={reason.code}>
              <strong>{reason.code}</strong>: {reason.message || "Rule triggered"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SummarySection({ result }: { result: ApiResult<RiskSummaryResponse> | null }) {
  if (!result) {
    return null;
  }
  if (!result.ok) {
    return (
      <section>
        <h2 style={{ marginBottom: 8 }}>Risk Summary</h2>
        <pre
          style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      </section>
    );
  }
  const summary = result.data;
  if (!summary) return null;
  return (
    <section>
      <h2 style={{ marginBottom: 8 }}>Risk Summary</h2>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <div style={{ padding: 12, background: "#f6f6f6", borderRadius: 12 }}>
          <strong>Top Certificates</strong>
          {summary.topCertificates.length === 0 ? (
            <p style={{ marginTop: 8 }}>No certificate scores yet.</p>
          ) : (
            <ul style={{ marginTop: 8 }}>
              {summary.topCertificates.map((item) => (
                <li key={item.certId}>
                  {item.certId} — {item.score} ({item.level})
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ padding: 12, background: "#f6f6f6", borderRadius: 12 }}>
          <strong>Top Listings</strong>
          {summary.topListings.length === 0 ? (
            <p style={{ marginTop: 8 }}>No listing scores yet.</p>
          ) : (
            <ul style={{ marginTop: 8 }}>
              {summary.topListings.map((item) => (
                <li key={item.listingId}>
                  {item.listingId} — {item.score} ({item.level})
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p style={{ marginTop: 8, color: "#666" }}>Updated: {summary.updatedAt}</p>
    </section>
  );
}

function AlertsSection({ result }: { result: ApiResult<{ alerts: RiskAlert[] }> | null }) {
  if (!result) {
    return null;
  }
  if (!result.ok) {
    return (
      <section>
        <h2 style={{ marginBottom: 8 }}>Recent Alerts</h2>
        <pre
          style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      </section>
    );
  }
  const alerts = result.data?.alerts || [];
  return (
    <section>
      <h2 style={{ marginBottom: 8 }}>Recent Alerts</h2>
      {alerts.length === 0 ? (
        <p>No alerts triggered.</p>
      ) : (
        <ul>
          {alerts.map((alert) => (
            <li key={alert.alertId}>
              {alert.targetType} {alert.targetId} — {alert.score} ({alert.level})
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReconciliationSection({
  result,
}: {
  result: ApiResult<LatestReconciliationResponse> | null;
}) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <section>
        <h2 style={{ marginBottom: 8 }}>Reconciliation</h2>
        <pre
          style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      </section>
    );
  }

  const data = result.data;
  if (!data) return null;

  return (
    <section>
      <h2 style={{ marginBottom: 8 }}>Reconciliation</h2>
      <div style={{ padding: 12, background: "#f6f6f6", borderRadius: 12 }}>
        <div>
          <strong>Freeze State:</strong>{" "}
          {data.freezeState.active ? "ACTIVE" : "INACTIVE"}
        </div>
        <div>
          <strong>Updated:</strong> {data.freezeState.updatedAt}
        </div>
        {data.freezeState.reason && (
          <div>
            <strong>Reason:</strong> {data.freezeState.reason}
          </div>
        )}
        {!data.run ? (
          <p style={{ marginTop: 8 }}>No reconciliation run yet.</p>
        ) : (
          <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
            <div>
              <strong>Run:</strong> {data.run.runId}
            </div>
            <div>
              <strong>Outstanding:</strong> {data.run.outstandingTotalGram}g
            </div>
            <div>
              <strong>Custody:</strong> {data.run.custodyTotalGram}g
            </div>
            <div>
              <strong>Mismatch:</strong> {data.run.mismatchGram}g (abs {data.run.absMismatchGram}g)
            </div>
            <div>
              <strong>Threshold:</strong> {data.run.thresholdGram}g
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const certId = params.certId?.trim() || "";
  const listingId = params.listingId?.trim() || "";
  const certificateServiceUrl =
    process.env.CERTIFICATE_SERVICE_URL || "http://127.0.0.1:4101";
  const riskStreamUrl = process.env.RISK_STREAM_URL || "http://127.0.0.1:4104";
  const reconciliationServiceUrl =
    process.env.RECONCILIATION_SERVICE_URL || "http://127.0.0.1:4105";

  let certificateResult: ApiResult<unknown> | null = null;
  let verifyResult: ApiResult<unknown> | null = null;
  let timelineResult: ApiResult<unknown> | null = null;
  let certificateRiskResult: ApiResult<{ profile: RiskProfileSummary }> | null = null;
  let listingRiskResult: ApiResult<{ profile: RiskProfileSummary }> | null = null;
  let riskSummaryResult: ApiResult<RiskSummaryResponse> | null = null;
  let riskAlertsResult: ApiResult<{ alerts: RiskAlert[] }> | null = null;
  let reconciliationResult: ApiResult<LatestReconciliationResponse> | null = null;

  riskSummaryResult = await fetchJson(`${riskStreamUrl}/risk/summary?limit=5`);
  riskAlertsResult = await fetchJson(`${riskStreamUrl}/risk/alerts?limit=5`);
  reconciliationResult = await fetchJson(`${reconciliationServiceUrl}/reconcile/latest`);

  if (certId) {
    certificateResult = await fetchJson(
      `${certificateServiceUrl}/certificates/${encodeURIComponent(certId)}`,
    );
    verifyResult = await fetchJson(`${certificateServiceUrl}/certificates/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ certId }),
    });
    timelineResult = await fetchJson(
      `${certificateServiceUrl}/certificates/${encodeURIComponent(certId)}/timeline`,
    );
    certificateRiskResult = await fetchJson(
      `${riskStreamUrl}/risk/certificates/${encodeURIComponent(certId)}`,
    );
  }
  if (listingId) {
    listingRiskResult = await fetchJson(
      `${riskStreamUrl}/risk/listings/${encodeURIComponent(listingId)}`,
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        background: "linear-gradient(180deg, #f7f3e9 0%, #edf2f7 100%)",
        fontFamily:
          "IBM Plex Mono, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      }}
    >
      <main
        style={{
          maxWidth: 1024,
          margin: "0 auto",
          padding: 24,
          background: "#fff",
          borderRadius: 16,
          boxShadow: "0 10px 30px rgba(15, 23, 42, 0.12)",
        }}
      >
        <h1>Digital Gold Certificates — Verifier</h1>
        <p>Milestone 10: reconciliation, risk summary, alerts, and drill-down.</p>

        <form method="GET" style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <input
            type="text"
            name="certId"
            placeholder="Enter certId (e.g. DGC-2026-...)"
            defaultValue={certId}
            style={{ flex: "1 1 280px", padding: 10, border: "1px solid #ccc", borderRadius: 8 }}
          />
          <input
            type="text"
            name="listingId"
            placeholder="Optional listingId"
            defaultValue={listingId}
            style={{ flex: "1 1 200px", padding: 10, border: "1px solid #ccc", borderRadius: 8 }}
          />
          <button type="submit" style={{ padding: "10px 14px", borderRadius: 8 }}>
            Verify
          </button>
        </form>

        <div style={{ display: "grid", gap: 16, marginBottom: 20 }}>
          <ReconciliationSection result={reconciliationResult} />
          <SummarySection result={riskSummaryResult} />
          <AlertsSection result={riskAlertsResult} />
        </div>

        {!certId && !listingId ? (
          <p>Masukkan `certId` atau `listingId` untuk melihat data real, timeline, dan skor risiko.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {certId && (
              <>
                <section>
                  <h2 style={{ marginBottom: 8 }}>Certificate</h2>
                  <pre
                    style={{
                      padding: 12,
                      background: "#f6f6f6",
                      borderRadius: 12,
                      overflowX: "auto",
                    }}
                  >
                    {JSON.stringify(certificateResult, null, 2)}
                  </pre>
                </section>
                <section>
                  <h2 style={{ marginBottom: 8 }}>Verify</h2>
                  <pre
                    style={{
                      padding: 12,
                      background: "#f6f6f6",
                      borderRadius: 12,
                      overflowX: "auto",
                    }}
                  >
                    {JSON.stringify(verifyResult, null, 2)}
                  </pre>
                </section>
                <section>
                  <h2 style={{ marginBottom: 8 }}>Timeline</h2>
                  <pre
                    style={{
                      padding: 12,
                      background: "#f6f6f6",
                      borderRadius: 12,
                      overflowX: "auto",
                    }}
                  >
                    {JSON.stringify(timelineResult, null, 2)}
                  </pre>
                </section>
              </>
            )}
            {certId && <RiskCard title="Certificate Risk" result={certificateRiskResult} />}
            {listingId && <RiskCard title="Listing Risk" result={listingRiskResult} />}
          </div>
        )}
      </main>
    </div>
  );
}
