import { Scenes } from "telegraf";

import { ClientDocument, getClientByTelegramId, grantAdmin } from "../db/clients";
import { addSubscriber } from "../db/subscribers";

interface AdminState {
  isAdmin?: boolean;
}

export type BotContext = Scenes.WizardContext;

export const MAX_PACKAGE_JSON_BYTES = 100 * 1024; // 100 KB

export const ALLOWED_MIME_TYPES = new Set([
  "application/json",
  "text/plain",
  "text/json",
  "application/octet-stream", // many Telegram clients send this for unknown types
]);

// Read once at module load; validated at bot startup via main().
const secret = process.env.APPROVE_SECRET!;

export function getText(ctx: BotContext): string | null {
  const msg = ctx.message;
  return msg && "text" in msg ? msg.text : null;
}

// Returns the text or null — replies "Please send text." and stays in the step.
export async function requireText(ctx: BotContext): Promise<string | null> {
  const text = getText(ctx);
  if (!text) {
    await ctx.reply("Please send text.");
    return null;
  }
  return text;
}

// Returns true if the secret matches. On failure replies, leaves the scene, returns false.
// Short-circuits to true if ctx.wizard.state already has isAdmin set (admin bypass path).
// On first successful validation, persists isAdmin via grantAdmin().
export async function checkSecret(ctx: BotContext, text: string): Promise<boolean> {
  if ((ctx.wizard.state as AdminState).isAdmin) return true;
  if (text !== secret) {
    await ctx.reply("Incorrect secret.");
    await ctx.scene.leave();
    return false;
  }
  await grantAdmin(ctx.from!.id, {
    username: ctx.from!.username,
    firstName: ctx.from!.first_name,
    lastName: ctx.from!.last_name,
  });
  await addSubscriber({ telegramId: ctx.from!.id, username: ctx.from!.username, subscribedAt: new Date() });
  return true;
}

export const CALLBACK_PREFIXES = {
  SELECT_CLIENT: "select:",
  CONFIRM_ACTION: "confirm:",
  SELECT_JOB: "job:",
  SELECT_OUTCOME: "outcome:",
} as const;

export function formatClientName(client: ClientDocument): string {
  return [client.firstName, client.lastName].filter(Boolean).join(" ");
}

// Validates a callback query with the given prefix. On success, answers the query and
// returns the data string after the prefix. On failure, replies with errorMsg and returns null.
export async function requireCallbackData(ctx: BotContext, prefix: string, errorMsg: string): Promise<string | null> {
  const cbq = ctx.callbackQuery;
  if (!cbq || !("data" in cbq) || !cbq.data.startsWith(prefix)) {
    await ctx.reply(errorMsg);
    return null;
  }
  await ctx.answerCbQuery();
  return cbq.data.slice(prefix.length);
}

// Shared first wizard step for all admin-gated scenes.
// If the user is a known admin, bypasses the secret prompt by jumping to and executing step 1 directly.
export const SECRET_PROMPT_STEP = async (ctx: BotContext) => {
  const client = await getClientByTelegramId(ctx.from!.id);
  if (client?.isAdmin) {
    (ctx.wizard.state as AdminState).isAdmin = true;
    ctx.wizard.selectStep(1);
    const step1 = ctx.wizard.step;
    if (step1 && typeof step1 === "function") {
      return step1(ctx, async () => {});
    }
    return;
  }
  await ctx.reply("Enter the admin secret:");
  return ctx.wizard.next();
};

