import { Router, Request, Response } from "express";

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

import { DockerPayload } from "../types";
import { resolveImages } from "../resolver";
import { downloadAndZip } from "../downloader";

export const jobsRouter = Router();

// POST /jobs — fire-and-forget download job
jobsRouter.post("/", async (req: Request, res: Response) => {
  const INPUT_DIR = resolve("input");
  const { id } = req.body as { id?: string };

  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "Request body must contain { id: string }" });
    return;
  }

  const inputPath = join(INPUT_DIR, `${id}.json`);
  if (!existsSync(inputPath)) {
    res.status(404).json({ error: `No uploaded file found for id: ${id}` });
    return;
  }

  res.status(202).json({ message: "Job started", id });

  runJob(id, inputPath).catch((err) => {
    console.error(`[job:${id}] failed:`, err instanceof Error ? err.message : err);
  });
});

async function runJob(id: string, inputPath: string): Promise<void> {
  const payload = JSON.parse(readFileSync(inputPath, "utf8")) as DockerPayload;
  console.log(`[job:${id}] resolving ${payload.images.length} image(s)…`);
  const { images } = resolveImages(payload);
  console.log(`[job:${id}] resolved ${images.length} image(s), starting pull…`);
  await downloadAndZip(images, id);
  console.log(`[job:${id}] complete → output/${id}.tgz`);
}
