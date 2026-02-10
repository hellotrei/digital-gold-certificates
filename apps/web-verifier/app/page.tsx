type SearchParams = Promise<{ certId?: string }>;

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

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

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const certId = params.certId?.trim();
  const certificateServiceUrl =
    process.env.CERTIFICATE_SERVICE_URL || "http://127.0.0.1:4101";

  let certificateResult: ApiResult<unknown> | null = null;
  let verifyResult: ApiResult<unknown> | null = null;
  let timelineResult: ApiResult<unknown> | null = null;

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
  }

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1>Digital Gold Certificates — Verifier</h1>
      <p>Milestone 3: real certificate lookup, signature verification, and timeline.</p>

      <form method="GET" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          name="certId"
          placeholder="Enter certId (e.g. DGC-2026-...)"
          defaultValue={certId || ""}
          style={{ flex: 1, padding: 10, border: "1px solid #ccc", borderRadius: 8 }}
        />
        <button type="submit" style={{ padding: "10px 14px", borderRadius: 8 }}>
          Verify
        </button>
      </form>

      {!certId ? (
        <p>Masukkan `certId` untuk melihat data real dari certificate-service.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <section>
            <h2 style={{ marginBottom: 8 }}>Certificate</h2>
            <pre
              style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
            >
              {JSON.stringify(certificateResult, null, 2)}
            </pre>
          </section>
          <section>
            <h2 style={{ marginBottom: 8 }}>Verify</h2>
            <pre
              style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
            >
              {JSON.stringify(verifyResult, null, 2)}
            </pre>
          </section>
          <section>
            <h2 style={{ marginBottom: 8 }}>Timeline</h2>
            <pre
              style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}
            >
              {JSON.stringify(timelineResult, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </main>
  );
}
