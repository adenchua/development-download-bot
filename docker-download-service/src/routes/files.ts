import { Router, Request, Response } from "express";
import { format, formatISO, isToday } from "date-fns";

import { readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";

import { DockerPayload } from "../types";

export const filesRouter = Router();

// POST /upload — body is a docker payload { images, platform? }
filesRouter.post("/upload", async (req: Request, res: Response) => {
  const INPUT_DIR = resolve("input");
  const body = req.body as DockerPayload;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "Request body must be a JSON object" });
    return;
  }

  if (!Array.isArray(body.images) || body.images.length === 0) {
    res.status(422).json({ error: 'Body must contain a non-empty "images" array' });
    return;
  }

  for (const image of body.images) {
    if (typeof image !== "string") {
      res.status(422).json({ error: "All entries in \"images\" must be strings" });
      return;
    }
  }

  const datePrefix = format(new Date(), "yyyyMMdd");
  const todayCount = readdirSync(INPUT_DIR).filter((file) => file.startsWith(datePrefix) && file.endsWith(".json")).length;
  const id = `${datePrefix}-${format(new Date(), "HHmm")}-${todayCount + 1}`;

  const sanitized: DockerPayload = {
    images: body.images,
    platform: typeof body.platform === "string" ? body.platform : "linux/amd64",
  };
  writeFileSync(join(INPUT_DIR, `${id}.json`), JSON.stringify(sanitized, null, 2));

  res.status(201).json({ id });
});

// GET /files — list all uploaded docker payload files
// Query params: showToday=true — only return files created today
filesRouter.get("/files", async (req: Request, res: Response) => {
  const INPUT_DIR = resolve("input");
  const showToday = req.query.showToday === "true";

  const entries = readdirSync(INPUT_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const stat = statSync(join(INPUT_DIR, file));
      return {
        id: basename(file, ".json"),
        filename: file,
        sizeBytes: stat.size,
        uploadedAt: formatISO(stat.birthtime),
        birthtime: stat.birthtime,
      };
    })
    .filter((entry) => !showToday || isToday(entry.birthtime))
    .map(({ birthtime: _birthtime, ...rest }) => rest);

  res.json(entries);
});
