export const swaggerDocument = {
  openapi: "3.1.0",
  info: {
    title: "docker-download-service",
    version: "1.0.0",
    description: "Pulls Docker images and bundles them as offline .tgz archives",
  },
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/upload": {
      post: {
        summary: "Upload a docker payload",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DockerPayload" },
            },
          },
        },
        responses: {
          "201": {
            description: "Payload accepted, returns job ID",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UploadResponse" },
              },
            },
          },
          "400": { description: "Invalid request body" },
          "422": { description: "Validation error" },
        },
      },
    },
    "/files": {
      get: {
        summary: "List uploaded payloads",
        parameters: [
          {
            name: "showToday",
            in: "query",
            schema: { type: "boolean" },
            description: "Filter to files uploaded today",
          },
        ],
        responses: {
          "200": {
            description: "List of uploaded files",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/FileEntry" },
                },
              },
            },
          },
        },
      },
    },
    "/jobs": {
      post: {
        summary: "Start a download job",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JobRequest" },
            },
          },
        },
        responses: {
          "202": { description: "Job started" },
          "400": { description: "Invalid request body" },
          "404": { description: "No uploaded file found for given ID" },
        },
      },
    },
  },
  components: {
    schemas: {
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          timestamp: { type: "string", format: "date-time" },
        },
      },
      DockerPayload: {
        type: "object",
        required: ["images"],
        properties: {
          images: {
            type: "array",
            items: { type: "string" },
            example: ["nginx:latest", "redis:7"],
          },
          platform: {
            type: "string",
            example: "linux/amd64",
            description: "Target platform (defaults to linux/amd64)",
          },
        },
      },
      UploadResponse: {
        type: "object",
        properties: {
          id: { type: "string", example: "20260522-1430-1" },
        },
      },
      FileEntry: {
        type: "object",
        properties: {
          id: { type: "string" },
          filename: { type: "string" },
          sizeBytes: { type: "number" },
          uploadedAt: { type: "string", format: "date-time" },
        },
      },
      JobRequest: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", example: "20260522-1430-1" },
        },
      },
    },
  },
};
