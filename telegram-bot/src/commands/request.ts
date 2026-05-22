import { Scenes } from "telegraf";

import { addJob } from "../db/jobs";
import { getClientByTelegramId } from "../db/clients";
import { getAllSubscribers } from "../db/subscribers";
import { BotContext, MAX_PACKAGE_JSON_BYTES, ALLOWED_MIME_TYPES } from "./helpers";
import { parseAndValidatePackageJson, parseNpmUrl } from "./parsers/npm";
import { parseDockerJson, parseDockerHubUrl } from "./parsers/docker";

export const REQUEST_SCENE_ID = "request";

const npmServiceUrl = process.env.NPM_DOWNLOAD_SERVICE_URL!;
const dockerServiceUrl = process.env.DOCKER_DOWNLOAD_SERVICE_URL!;

// Reads the message as either a document download or inline text, returning the raw string.
// Returns null (having already replied) on size/type violations.
export async function resolveRawText(ctx: BotContext): Promise<string | null> {
  const msg = ctx.message;
  if (!msg) return null;

  if ("document" in msg) {
    const { file_size, mime_type, file_name } = msg.document;
    if (file_size && file_size > MAX_PACKAGE_JSON_BYTES) {
      await ctx.reply("File is too large. Please send a file under 100 KB.");
      return null;
    }
    const mime = mime_type ?? "";
    const ext = (file_name ?? "").split(".").pop()?.toLowerCase() ?? "";
    if (mime && !ALLOWED_MIME_TYPES.has(mime) && ext !== "json" && ext !== "txt") {
      await ctx.reply("Unsupported file type. Please send a JSON file.");
      return null;
    }
    const fileLink = await ctx.telegram.getFileLink(msg.document.file_id);
    const res = await fetch(fileLink.href);
    const text = await res.text();
    if (text.length > MAX_PACKAGE_JSON_BYTES) {
      await ctx.reply("File content is too large. Please send a file under 100 KB.");
      return null;
    }
    return text;
  } else if ("text" in msg) {
    return msg.text;
  } else {
    await ctx.reply("Please send a file, paste JSON text, or send a package URL.");
    return null;
  }
}

// Uploads payload to a download service, records the job, fires the job, and notifies subscribers.
async function submitJob(
  ctx: BotContext,
  serviceUrl: string,
  serviceType: "npm" | "docker",
  payload: Record<string, unknown>,
): Promise<void> {
  let id: string;
  try {
    const uploadRes = await fetch(`${serviceUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!uploadRes.ok) throw new Error(`HTTP ${uploadRes.status}`);
    ({ id } = (await uploadRes.json()) as { id: string });
  } catch (err) {
    console.error("Upload error:", err);
    await ctx.reply("Failed to upload request. Please try again later.");
    return;
  }

  const client = await getClientByTelegramId(ctx.from!.id);
  if (client) {
    try {
      await addJob({ clientId: client._id, jobId: id, startedAt: new Date(), serviceType });
    } catch (err) {
      console.error("Job record error:", err);
    }
  }

  try {
    await fetch(`${serviceUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch (err) {
    console.error("Job start error:", err);
  }

  await ctx.reply(`Job started! Your download ID is:\n\`${id}\``, { parse_mode: "Markdown" });

  const subscribers = await getAllSubscribers();
  const from = ctx.from!;
  const senderDisplay = from.username ? `@${from.username}` : (from.first_name ?? String(from.id));
  const notification = `New download job started by ${senderDisplay}:\n\`${id}\``;
  await Promise.allSettled(
    subscribers.map((sub) => ctx.telegram.sendMessage(sub.telegramId, notification, { parse_mode: "Markdown" })),
  );
}

export async function processPackageJsonRequest(ctx: BotContext, pkg: Record<string, unknown>): Promise<void> {
  await submitJob(ctx, npmServiceUrl, "npm", pkg);
}

export async function processNpmUrlRequest(ctx: BotContext, name: string, version: string): Promise<void> {
  const pkg: Record<string, unknown> = { dependencies: { [name]: version } };
  await submitJob(ctx, npmServiceUrl, "npm", pkg);
}

export async function processDockerJsonRequest(
  ctx: BotContext,
  payload: { images: string[]; platform: string },
): Promise<void> {
  await submitJob(ctx, dockerServiceUrl, "docker", payload as Record<string, unknown>);
}

export const requestScene = new Scenes.WizardScene<BotContext>(
  REQUEST_SCENE_ID,

  // Step 1 — prompt for input
  async (ctx) => {
    await ctx.reply(
      "Please send your package.json or docker JSON as a file, paste the JSON text, or send a package URL (npmjs.com or hub.docker.com).",
    );
    return ctx.wizard.next();
  },

  // Step 2 — detect service type and dispatch
  async (ctx) => {
    const msg = ctx.message;
    if (msg && "text" in msg) {
      const npmParsed = parseNpmUrl(msg.text);
      if (npmParsed) {
        await processNpmUrlRequest(ctx, npmParsed.name, npmParsed.version);
        return ctx.scene.leave();
      }
      const dockerParsed = parseDockerHubUrl(msg.text);
      if (dockerParsed) {
        await processDockerJsonRequest(ctx, dockerParsed);
        return ctx.scene.leave();
      }
    }

    const rawText = await resolveRawText(ctx);
    if (rawText === null) return;

    // npm takes priority: presence of dep fields beats images key
    const pkg = parseAndValidatePackageJson(rawText);
    if (pkg) {
      await processPackageJsonRequest(ctx, pkg);
      return ctx.scene.leave();
    }

    const dockerPayload = parseDockerJson(rawText);
    if (dockerPayload) {
      await processDockerJsonRequest(ctx, dockerPayload);
      return ctx.scene.leave();
    }

    await ctx.reply(
      "Could not parse input. Send a package.json, a docker JSON ({ images: [...] }), or a valid package URL.",
    );
  },
);
