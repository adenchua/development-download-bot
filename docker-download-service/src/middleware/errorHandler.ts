import { ErrorRequestHandler } from "express";

export interface AppError extends Error {
  statusCode?: number;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const statusCode = (err as AppError).statusCode ?? 500;
  const message = err instanceof Error ? err.message : "Internal server error";

  if (process.env.NODE_ENV !== "production") {
    console.error(err);
  } else {
    console.error(`[${statusCode}] ${message}`);
  }

  res.status(statusCode).json({ error: message });
};
