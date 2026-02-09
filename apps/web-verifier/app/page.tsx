import { canonicalJson, sha256Hex } from "@dgc/shared";

export default function Page() {
  const demo = { hello: "dgc", time: new Date(0).toISOString() };
  const hash = sha256Hex(canonicalJson(demo));

  return (
    <main>
      <h1>Digital Gold Certificates — Verifier</h1>
      <p>Minimal starter page. Next step: QR scan + fetch timeline.</p>

      <pre style={{ padding: 12, background: "#f6f6f6", borderRadius: 12, overflowX: "auto" }}>
        {JSON.stringify({ demo, canonical: canonicalJson(demo), sha256: hash }, null, 2)}
      </pre>
    </main>
  );
}
