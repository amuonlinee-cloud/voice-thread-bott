// src/linkHandler.js (ESM)
import * as db from "./database.js";
import { extractSocialLink } from "./utils.js";

export async function handleIncomingLink(text, telegramUser) {
  const link = extractSocialLink(text);
  if (!link) throw new Error("Not a supported social link");

  await db.getOrCreateUser(telegramUser);
  const thread = await db.createThreadIfNotExists(link, telegramUser.id);
  return thread;
}
