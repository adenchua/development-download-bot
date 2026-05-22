import express from "express";
import { formatISO } from "date-fns";
import swaggerUi from "swagger-ui-express";

import { filesRouter } from "./routes/files";
import { jobsRouter } from "./routes/jobs";
import { errorHandler } from "./middleware/errorHandler";
import { swaggerDocument } from "./swagger";

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: formatISO(new Date()) });
  });

  app.use("/", filesRouter);
  app.use("/jobs", jobsRouter);

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);

  return app;
}
