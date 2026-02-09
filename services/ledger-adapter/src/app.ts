import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "ledger-adapter" }));

// TODO: Implement domain routes per service responsibility.
// - certificate-service: issue/sign/verify
// - marketplace-service: listing/escrow/settlement
// - ledger-adapter: anchor proofs + read ownership events
// - risk-stream: ingest events + heuristics (anti-fraud, anomaly detection)

const port = Number(process.env.PORT || 0) || 4103;

app.listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info("ledger-adapter listening on :" + port))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
