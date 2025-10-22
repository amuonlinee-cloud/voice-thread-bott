// src/database.js (ESM) — full Supabase wrapper and DB helpers
import { createClient } from "@supabase/supabase-js";

/**
 * Defensive env-check: helpful error if keys missing
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const missing = [];
if (!SUPABASE_URL) missing.push("SUPABASE_URL");
if (!SUPABASE_KEY) missing.push("SUPABASE_KEY");
if (missing.length) {
  throw new Error(
    `Supabase env vars missing: ${missing.join(
      ", "
    )}. Add them to your .env (use service_role key for server).`
  );
}

/**
 * Create client (server-side use: service_role key)
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

/* -------------------------
   USERS
   ------------------------- */

/**
 * getOrCreateUser(telegramUser)
 * telegramUser: { id, username, first_name }
 */
export async function getOrCreateUser(telegramUser) {
  const telegram_id = telegramUser.id;
  const { data: existing, error: selErr } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegram_id)
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { data, error } = await supabase
    .from("users")
    .insert({
      telegram_id,
      username: telegramUser.username ?? null,
      first_name: telegramUser.first_name ?? null,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* -------------------------
   THREADS
   ------------------------- */

export async function createThreadIfNotExists(social_link, creator_telegram_id) {
  const { data: found, error: fErr } = await supabase
    .from("threads")
    .select("*")
    .eq("social_link", social_link)
    .limit(1)
    .maybeSingle();
  if (fErr) throw fErr;
  if (found) return found;

  const { data, error } = await supabase
    .from("threads")
    .insert({ social_link, creator_telegram_id })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getThreadByLink(social_link) {
  const { data, error } = await supabase
    .from("threads")
    .select("*")
    .eq("social_link", social_link)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* -------------------------
   VOICE COMMENTS
   ------------------------- */

export async function createVoiceComment({
  thread_id,
  telegram_id,
  username,
  first_name,
  telegram_file_id,
  duration = 0,
  language_code = null,
}) {
  const { data, error } = await supabase
    .from("voice_comments")
    .insert({
      thread_id,
      telegram_id,
      username,
      first_name,
      telegram_file_id,
      duration,
      language_code,
    })
    .select()
    .maybeSingle();
  if (error) throw error;

  // best-effort increment voice_comments_sent on users
  try {
    const { data: u } = await supabase
      .from("users")
      .select("voice_comments_sent")
      .eq("telegram_id", telegram_id)
      .limit(1)
      .maybeSingle();
    const next = ((u && u.voice_comments_sent) || 0) + 1;
    await supabase
      .from("users")
      .update({ voice_comments_sent: next })
      .eq("telegram_id", telegram_id);
  } catch (e) {
    // ignore silently; not critical
  }

  return data;
}

export async function getVoiceCommentById(id) {
  const { data, error } = await supabase
    .from("voice_comments")
    .select("*")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listVoiceComments(thread_id, page = 1, pageSize = 15) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await supabase
    .from("voice_comments")
    .select("*")
    .eq("thread_id", thread_id)
    .order("created_at", { ascending: true })
    .range(from, to);
  if (error) throw error;
  return data || [];
}

/* -------------------------
   VOICE REPLIES
   ------------------------- */

export async function createVoiceReply({
  comment_id,
  replier_telegram_id,
  replier_username,
  replier_first_name,
  telegram_file_id,
  reply_text = null,
}) {
  const { data, error } = await supabase
    .from("voice_replies")
    .insert({
      comment_id,
      replier_telegram_id,
      replier_username,
      replier_first_name,
      telegram_file_id,
      reply_text,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* -------------------------
   REACTIONS
   ------------------------- */

export async function addReaction({ comment_id, user_id, type }) {
  // type must be 'like' or 'dislike' — rely on DB constraint
  const { data, error } = await supabase
    .from("voice_reactions")
    .insert({ comment_id, user_id, type })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/* -------------------------
   NOTIFICATIONS
   ------------------------- */

export async function createNotification({ telegram_id, type, message, meta = {} }) {
  const { data, error } = await supabase
    .from("notifications")
    .insert({ telegram_id, type, message, meta })
    .select()
    .maybeSingle();
  if (error) throw error;

  // Best-effort: call RPC increment_unread_replies if present
  try {
    await supabase.rpc("increment_unread_replies", { p_telegram_id: telegram_id });
  } catch (e) {
    // ignore if RPC doesn't exist or permission issue
  }

  return data;
}

export async function getNotifications(telegram_id) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("telegram_id", telegram_id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

export async function clearNotifications(telegram_id) {
  const { data, error } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("telegram_id", telegram_id);
  if (error) throw error;

  // reset unread count on user (best-effort)
  try {
    await supabase
      .from("users")
      .update({ unread_replies_count: 0 })
      .eq("telegram_id", telegram_id);
  } catch (e) {}

  return data;
}

/* -------------------------
   UTILS / EXPORTS
   ------------------------- */

export default {
  supabase,
  getOrCreateUser,
  createThreadIfNotExists,
  getThreadByLink,
  createVoiceComment,
  getVoiceCommentById,
  listVoiceComments,
  createVoiceReply,
  addReaction,
  createNotification,
  getNotifications,
  clearNotifications,
};
