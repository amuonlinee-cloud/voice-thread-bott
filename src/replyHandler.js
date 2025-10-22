// src/replyHandler.js (ESM)
import * as db from "./database.js";

/**
 * createReplyAndNotify({ bot, replier, comment_id, telegram_file_id, reply_text })
 * - creates the reply row
 * - creates a notifications row (with meta linking to comment_id and thread_id)
 * - attempts to send an immediate Telegram message to the original commenter
 */
export async function createReplyAndNotify({ bot, replier, comment_id, telegram_file_id, reply_text = null }) {
  const newReply = await db.createVoiceReply({
    comment_id,
    replier_telegram_id: replier.id,
    replier_username: replier.username,
    replier_first_name: replier.first_name,
    telegram_file_id,
    reply_text,
  });

  const original = await db.getVoiceCommentById(comment_id);
  if (!original) return { newReply, notified: false };

  const message = `🔔 New reply on your voice comment for video: ${original.thread_id}`;
  await db.createNotification({
    telegram_id: original.telegram_id,
    type: "reply",
    message,
    meta: { comment_id, reply_id: newReply.id, thread_id: original.thread_id },
  });

  try {
    const text = `🔔 ${replier.first_name || replier.username || "Someone"} replied to your voice comment.\nOpen the bot to view the reply and the video thread.`;
    await bot.telegram.sendMessage(original.telegram_id, text);
  } catch (err) {
    // ignore send errors
  }

  return { newReply, notified: true };
}
