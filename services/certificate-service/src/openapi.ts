export function buildOpenApiSpec(serviceBaseUrl: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "DGC Certificate Service API",
      version: "0.2.0",
      description: "Milestone 2 API for issuing and verifying signed digital gold certificates.",
    },
    servers: [{ url: serviceBaseUrl }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: {
            "200": { description: "Service healthy" },
          },
        },
      },
      "/certificates/issue": {
        post: {
          summary: "Issue and sign a certificate",
          responses: {
            "201": { description: "Certificate issued" },
            "400": { description: "Invalid request" },
          },
        },
      },
      "/certificates/verify": {
        post: {
          summary: "Verify certificate hash and signature",
          responses: {
            "200": { description: "Verification result" },
            "400": { description: "Invalid request" },
            "404": { description: "Certificate not found" },
          },
        },
      },
      "/certificates/{certId}": {
        get: {
          summary: "Get certificate by ID",
          parameters: [
            {
              in: "path",
              name: "certId",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Certificate found" },
            "404": { description: "Certificate not found" },
          },
        },
      },
    },
  };
}
