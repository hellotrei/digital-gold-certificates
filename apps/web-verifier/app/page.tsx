type SearchParams = Promise<{ certId?: string; listingId?: string }>;

type ApiResult<T> = {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
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
  result: ApiResult<{
    profile: { score: number; level: string; reasons: Array<{ code: string; message?: string }> };
  }> | null;
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

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const certId = params.certId?.trim() || "";
  const listingId = params.listingId?.trim() || "";
  const certificateServiceUrl =
    process.env.CERTIFICATE_SERVICE_URL || "http://127.0.0.1:4101";
  const riskStreamUrl = process.env.RISK_STREAM_URL || "http://127.0.0.1:4104";

  let certificateResult: ApiResult<unknown> | null = null;
  let verifyResult: ApiResult<unknown> | null = null;
  let timelineResult: ApiResult<unknown> | null = null;
  let certificateRiskResult:
    | ApiResult<{
        profile: { score: number; level: string; reasons: Array<{ code: string; message?: string }> };
      }>
    | null = null;
  let listingRiskResult:
    | ApiResult<{
        profile: { score: number; level: string; reasons: Array<{ code: string; message?: string }> };
      }>
    | null = null;

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
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1>Digital Gold Certificates — Verifier</h1>
      <p>Milestone 8: certificate + timeline data plus risk scoring.</p>

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
  );
}
