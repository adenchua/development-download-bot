import { Scenes, Markup } from "telegraf";
import { format } from "date-fns";

import { getPendingJobs, updateJobStatus, getJobByJobId, JobDocument } from "../db/jobs";
import { getClientById, ClientDocument } from "../db/clients";
import {
  BotContext,
  requireText,
  checkSecret,
  formatClientName,
  requireCallbackData,
  CALLBACK_PREFIXES,
  SECRET_PROMPT_STEP,
} from "./helpers";
import { logger } from "../logger";

export const NOTIFY_CLIENT_SCENE_ID = "notify_client";

interface NotifyState {
  selectedJobId?: string;
}

function jobButtonLabel(job: JobDocument, client: ClientDocument): string {
  const serviceTagMap: Record<string, string> = { npm: "[npm]", python: "[python]" };
  const serviceTag = serviceTagMap[job.serviceType ?? "npm"] ?? "[npm]";
  const handle = client.username ? ` (@${client.username})` : "";
  const date = format(job.startedAt, "dd MMM yyyy HH:mm");
  return `${serviceTag} ${job.jobId} — ${formatClientName(client)}${handle} [${date}]`;
}

async function sendJobOutcomeToClient(
  ctx: BotContext,
  client: ClientDocument,
  status: "success" | "failed",
  jobId: string,
): Promise<boolean> {
  const clientMessage =
    status === "success"
      ? `Your download job \`${jobId}\` has completed successfully. ✓`
      : `Your download job \`${jobId}\` failed to complete. Please submit a new request or contact an admin.`;

  try {
    await ctx.telegram.sendMessage(client.telegramId, clientMessage, { parse_mode: "Markdown" });
    return true;
  } catch (err) {
    logger.error(`Failed to notify client ${client.telegramId}:`, err);
    return false;
  }
}

export const notifyClientScene = new Scenes.WizardScene<BotContext>(
  NOTIFY_CLIENT_SCENE_ID,

  // Step 1 — prompt for secret
  SECRET_PROMPT_STEP,

  // Step 2 — validate secret, show last 5 pending jobs
  async (ctx) => {
    const text = await requireText(ctx);
    if (text === null) return;
    if (!(await checkSecret(ctx, text))) return;

    const pendingJobs = await getPendingJobs(5, 7);
    if (pendingJobs.length === 0) {
      await ctx.reply("No pending jobs.");
      return ctx.scene.leave();
    }

    const clientResults = await Promise.all(pendingJobs.map((job) => getClientById(job.clientId)));

    const jobsWithClients = pendingJobs
      .map((job, index) => ({ job, client: clientResults[index] }))
      .filter((entry): entry is { job: JobDocument; client: ClientDocument } => entry.client !== null);

    if (jobsWithClients.length === 0) {
      await ctx.reply("No pending jobs with resolvable clients.");
      return ctx.scene.leave();
    }

    const buttons = jobsWithClients.map(({ job, client }) => [
      Markup.button.callback(jobButtonLabel(job, client), `${CALLBACK_PREFIXES.SELECT_JOB}${job.jobId}`),
    ]);

    await ctx.reply("Select a job to update:", Markup.inlineKeyboard(buttons));
    return ctx.wizard.next();
  },

  // Step 3 — handle job selection, show Success / Failed buttons
  async (ctx) => {
    const selectedJobId = await requireCallbackData(
      ctx,
      CALLBACK_PREFIXES.SELECT_JOB,
      "Please select a job from the list above.",
    );
    if (selectedJobId === null) return;

    const selectedJob = await getJobByJobId(selectedJobId);
    if (!selectedJob) {
      await ctx.reply("Job not found.");
      return ctx.scene.leave();
    }
    if (selectedJob.status) {
      await ctx.reply(`Job \`${selectedJobId}\` has already been resolved as *${selectedJob.status}*.`, {
        parse_mode: "Markdown",
      });
      return ctx.scene.leave();
    }

    (ctx.wizard.state as NotifyState).selectedJobId = selectedJobId;

    await ctx.reply(`Selected job: \`${selectedJobId}\`\n\nWhat was the outcome?`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("Success", `${CALLBACK_PREFIXES.SELECT_OUTCOME}success`),
          Markup.button.callback("Failed", `${CALLBACK_PREFIXES.SELECT_OUTCOME}failed`),
        ],
      ]),
    });
    return ctx.wizard.next();
  },

  // Step 4 — handle outcome, update DB, notify client
  async (ctx) => {
    const outcome = await requireCallbackData(
      ctx,
      CALLBACK_PREFIXES.SELECT_OUTCOME,
      "Please use the Success / Failed buttons above.",
    );
    if (outcome === null) return;

    const { selectedJobId } = ctx.wizard.state as NotifyState;
    if (!selectedJobId) {
      await ctx.reply("Something went wrong. Please try again.");
      return ctx.scene.leave();
    }

    const job = await getJobByJobId(selectedJobId);
    if (!job) {
      await ctx.reply("Job not found.");
      return ctx.scene.leave();
    }
    if (job.status) {
      await ctx.reply(`Job \`${selectedJobId}\` has already been resolved as *${job.status}*.`, {
        parse_mode: "Markdown",
      });
      return ctx.scene.leave();
    }

    const status = outcome === "success" ? "success" : "failed";

    const updated = await updateJobStatus(selectedJobId, status, ctx.from!.id);
    if (!updated) {
      await ctx.reply("Job not found.");
      return ctx.scene.leave();
    }

    const client = await getClientById(job.clientId);
    if (!client) {
      await ctx.reply("Job updated but client could not be found — no notification sent.");
      return ctx.scene.leave();
    }

    const notified = await sendJobOutcomeToClient(ctx, client, status, selectedJobId);
    if (!notified) {
      await ctx.reply(
        `Job \`${selectedJobId}\` marked as ${status}, but the client notification could not be delivered.`,
        { parse_mode: "Markdown" },
      );
      return ctx.scene.leave();
    }

    await ctx.reply(`Job \`${selectedJobId}\` marked as ${status}. Client notified.`, { parse_mode: "Markdown" });
    return ctx.scene.leave();
  },
);
