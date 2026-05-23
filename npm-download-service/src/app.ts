import express from "express";
import { formatISO } from "date-fns";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

import { filesRouter } from "./routes/files";
import { jobsRouter } from "./routes/jobs";
import { resolveRouter } from "./routes/resolve";
import { errorHandler } from "./middleware/errorHandler";
import { swaggerDocument } from "./swagger";

export function createApp(): express.Application {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: formatISO(new Date()) });
  });

  app.use("/", filesRouter);
  app.use("/", resolveRouter);
  app.use("/jobs", jobsRouter);

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);

  return app;
}
