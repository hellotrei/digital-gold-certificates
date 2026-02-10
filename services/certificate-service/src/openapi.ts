export function buildOpenApiSpec(serviceBaseUrl: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "DGC Certificate Service API",
      version: "0.3.0",
      description: "Milestone 3 API for issue, verify, transfer, split, status updates, and timeline.",
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
      "/certificates/transfer": {
        post: {
          summary: "Transfer certificate ownership (ACTIVE only)",
          responses: {
            "200": { description: "Transfer success" },
            "400": { description: "Invalid request" },
            "404": { description: "Certificate not found" },
            "409": { description: "State conflict" },
          },
        },
      },
      "/certificates/split": {
        post: {
          summary: "Split parent certificate into parent+child certificates",
          responses: {
            "200": { description: "Split success" },
            "400": { description: "Invalid request" },
            "404": { description: "Parent certificate not found" },
            "409": { description: "State conflict" },
          },
        },
      },
      "/certificates/status": {
        post: {
          summary: "Update certificate status with transition checks",
          responses: {
            "200": { description: "Status updated" },
            "400": { description: "Invalid request" },
            "404": { description: "Certificate not found" },
            "409": { description: "State conflict" },
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
      "/certificates/{certId}/timeline": {
        get: {
          summary: "Get certificate timeline from ledger adapter",
          parameters: [
            {
              in: "path",
              name: "certId",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Timeline fetched" },
            "503": { description: "Ledger adapter not configured" },
          },
        },
      },
    },
  };
}
