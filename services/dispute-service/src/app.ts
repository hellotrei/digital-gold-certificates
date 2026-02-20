import { buildServer } from "./server.js";

const port = Number(process.env.PORT || 0) || 4106;

buildServer()
  .then((app) => app.listen({ port, host: "0.0.0.0" }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
