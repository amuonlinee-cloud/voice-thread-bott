// src/bot.js
// Updated: Favorites button + listing, and short-code sent as plain single-token message (copyable).
// Drop-in replacement. Keep your .env and DB tables (favorites/checkpoints SQL required once).

import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Missing Supabase env vars in .env");

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// configs
const LISTEN_PAGE_SIZE = parseInt(process.env.LISTEN_PAGE_SIZE || "10", 10);
const NOTIF_PAGE_SIZE = 15;

// in-memory pending actions
const pendingAction = new Map();

// keyboard (added ⭐ Favorites)
function mainKeyboard() {
  return Markup.keyboard([
    ["🎥 Add Comment", "➕ Add My Video"],
    ["🔖 Track Video", "🎧 Listen Comments"],
    ["💬 My Comments", "🔎 Search"],
    ["⭐ Favorites"]
  ]).resize();
}

// short-code helpers (6-char base36)
function encodeShortCode(id) {
  if (!Number.isFinite(id)) return null;
  const s = id.toString(36).toUpperCase();
  return s.padStart(6, "0");
}
function decodeShortCode(code) {
  if (!code) return null;
  const cleaned = code.trim().replace(/^0+/, "") || "0";
  const parsed = parseInt(cleaned, 36);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureUser(telegramUser) {
  const telegram_id = telegramUser.id;
  const payload = {
    telegram_id,
    username: telegramUser.username ?? null,
    first_name: telegramUser.first_name ?? null,
  };
  const { error } = await supabase.from("users").upsert([payload], { onConflict: "telegram_id" });
  if (error) {
    console.error("ensureUser error:", error);
    throw error;
  }
}

function extractFirstUrl(text) {
  if (!text) return null;
  const m = text.match(/(https?:\/\/[^\s]+)/i);
  return m ? m[0] : null;
}
function isSupportedLink(text) {
  if (!text) return false;
  return /(https?:\/\/(?:www\.|m\.)?(?:tiktok\.com|vt\.tiktok\.com|youtube\.com|youtu\.be)\/[^\s]+)/i.test(text);
}

async function createThread(link, creatorTelegramId = null) {
  try {
    const { data: existing } = await supabase.from("threads").select("*").eq("social_link", link).limit(1).maybeSingle();
    if (existing) return existing;
    const payload = { social_link: link };
    if (creatorTelegramId != null) payload.creator_telegram_id = creatorTelegramId;
    const { data, error } = await supabase.from("threads").insert([payload]).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error("createThread error:", e);
    throw e;
  }
}

async function addReaction(commentId, userId, type) {
  return await supabase.from("voice_reactions").insert([{ comment_id: commentId, user_id: userId, type }]);
}
async function insertReply({ commentId, replier, telegram_file_id = null, reply_text = null, parent_reply_id = null }) {
  return await supabase.from("voice_replies").insert([{
    comment_id: commentId,
    replier_telegram_id: replier.id,
    replier_username: replier.username ?? null,
    replier_first_name: replier.first_name ?? null,
    telegram_file_id,
    reply_text,
    parent_reply_id
  }]).select().maybeSingle();
}

// Favorites helpers (requires favorites table created via SQL)
async function toggleFavorite(userId, commentId) {
  try {
    const { data: existing } = await supabase.from("favorites").select("*").eq("telegram_id", userId).eq("comment_id", commentId).limit(1).maybeSingle();
    if (existing) {
      const { error } = await supabase.from("favorites").delete().eq("id", existing.id);
      if (error) throw error;
      return { action: "removed" };
    } else {
      const { error } = await supabase.from("favorites").insert([{ telegram_id: userId, comment_id: commentId }]);
      if (error) throw error;
      return { action: "added" };
    }
  } catch (e) {
    throw e;
  }
}
async function listFavorites(userId) {
  // returns array of comment rows
  try {
    const { data: favs } = await supabase.from("favorites").select("comment_id").eq("telegram_id", userId).order("created_at", { ascending: false }).limit(200);
    if (!favs || favs.length === 0) return [];
    const ids = favs.map(f => f.comment_id);
    const { data: comments } = await supabase.from("voice_comments").select("*").in("id", ids).order("created_at", { ascending: false });
    return comments || [];
  } catch (e) {
    throw e;
  }
}

async function setCheckpoint(userId, commentId) {
  const { error } = await supabase.from("checkpoints").upsert([{ telegram_id: userId, comment_id: commentId }], { onConflict: "telegram_id" });
  if (error) throw error;
  return { ok: true };
}
async function getCheckpoint(userId) {
  try {
    const { data } = await supabase.from("checkpoints").select("*").eq("telegram_id", userId).limit(1).maybeSingle();
    return data || null;
  } catch (e) {
    return null;
  }
}

async function getReactionCounts(commentId) {
  try {
    const types = ["heart", "laugh", "dislike"];
    const out = {};
    for (const t of types) {
      const resp = await supabase.from("voice_reactions").select("id", { count: "exact", head: true }).eq("comment_id", commentId).eq("type", t);
      out[t] = resp.count || 0;
    }
    return out;
  } catch (e) {
    return { heart: 0, laugh: 0, dislike: 0 };
  }
}
async function getRepliesCount(commentId) {
  try {
    const resp = await supabase.from("voice_replies").select("id", { count: "exact", head: true }).eq("comment_id", commentId);
    return resp.count || 0;
  } catch (e) {
    return 0;
  }
}

// ---------------- START & HELP ----------------
bot.start(async (ctx) => {
  try {
    const { data: existing } = await supabase.from("users").select("*").eq("telegram_id", ctx.from.id).limit(1).maybeSingle();
    if (existing) {
      const name = ctx.from.first_name || "there";
      const free = existing.free_comments ?? null;
      const unread = existing.unread_replies_count ?? null;
      let letter = `Welcome back ${name}! Good to see you again.`;
      if (free !== null || unread !== null) {
        letter += "\n\nYour summary:";
        if (free !== null) letter += `\n• Free comments left: ${free}`;
        if (unread !== null) letter += `\n• Unread replies: ${unread}`;
      } else {
        letter += "\n\nUse 🔎 Search to find a voice by code, or send a TikTok/YouTube link to add a comment.";
      }
      await ctx.reply(letter, mainKeyboard());
    } else {
      const name = ctx.from.first_name || "friend";
      await ctx.reply(
        `Hi ${name} — I'm *Mr World Voice Comment Bot* 🎙️\nSend a TikTok/YouTube link and you can add a voice comment for it.\nUse ➕ Add My Video to track your videos and receive tracked notifications with the reply voice.`,
        { parse_mode: "Markdown", ...mainKeyboard() }
      );
    }
    await ensureUser(ctx.from);
  } catch (e) {
    console.error("/start error:", e);
    await ctx.reply("Welcome! (There was a small error fetching your profile.)", mainKeyboard());
    try { await ensureUser(ctx.from); } catch (_) {}
  }
});

bot.command("help", (ctx) => {
  ctx.reply(
    `Help:\n• 🎥 Add Comment — create a public thread\n• ➕ Add My Video — track your video (you get notified)\n• 🔖 Track Video — list/delete your tracked videos\n• 🎧 Listen Comments — listen (paginated)\n• 🔎 Search — find a voice by code (or use /search CODE)\n• ⭐ Favorites — view saved voices\n• 💬 My Comments — list/play/delete your comments`,
    mainKeyboard()
  );
});

// ---------------- SEARCH ----------------
bot.command("search", async (ctx) => {
  const parts = ctx.message.text ? ctx.message.text.split(/\s+/).slice(1) : [];
  if (!parts || parts.length === 0) {
    pendingAction.set(ctx.from.id, { type: "search_prompt" });
    return ctx.reply("🔎 Send the short code (e.g. 0000A9) or use /search CODE.", mainKeyboard());
  }
  const code = parts[0].trim();
  return handleSearchCode(ctx, code);
});

async function handleSearchCode(ctx, code) {
  try {
    if (!code || typeof code !== "string") return ctx.reply("Please provide a short code (e.g. 0000A9).", mainKeyboard());
    const id = decodeShortCode(code.toUpperCase());
    if (!id) return ctx.reply("Code looks invalid. It should be a short base36 code like 0000A9.", mainKeyboard());
    const { data: comment } = await supabase.from("voice_comments").select("*").eq("id", id).limit(1).maybeSingle();
    if (!comment) return ctx.reply("No voice comment found for that code.", mainKeyboard());

    const { data: thread } = await supabase.from("threads").select("*").eq("id", comment.thread_id).limit(1).maybeSingle();
    const reactionCounts = await getReactionCounts(comment.id);
    const repliesCount = await getRepliesCount(comment.id);
    const captionLines = [
      `Code: ${encodeShortCode(comment.id)}  (id ${comment.id})`,
      `From: ${comment.first_name || comment.username || "User"}`,
      `Posted: ${new Date(comment.created_at).toLocaleString()}`,
      `Video: ${thread ? thread.social_link : "(unknown)"}`,
      `Reactions: ❤️ ${reactionCounts.heart}  😂 ${reactionCounts.laugh}  👎 ${reactionCounts.dislike}`,
      `Replies: ${repliesCount}`
    ];
    const caption = captionLines.join("\n");

    // send voice with caption
    await ctx.replyWithVoice(comment.telegram_file_id, { caption });
    // send code as single-token plain message (copyable)
    await ctx.reply(encodeShortCode(comment.id));
    await ctx.reply("Actions for this voice:",
      Markup.inlineKeyboard([
        [Markup.button.callback("★ Favorite", `fav_${comment.id}`), Markup.button.callback("📍 Set checkpoint", `checkpoint_${comment.id}`)],
        [Markup.button.callback("💬 Reply (voice)", `replyvoice_${comment.id}`), Markup.button.callback("✍️ Reply (text)", `replytext_${comment.id}`)],
        [Markup.button.callback(`❤️ ${reactionCounts.heart}`, `react_${comment.id}_heart`), Markup.button.callback(`😂 ${reactionCounts.laugh}`, `react_${comment.id}_laugh`), Markup.button.callback(`👎 ${reactionCounts.dislike}`, `react_${comment.id}_dislike`)],
        [Markup.button.callback("▶️ Play", `play_comment_${comment.id}`)]
      ])
    );
  } catch (e) {
    console.error("handleSearchCode error:", e);
    return ctx.reply("⚠️ Search failed (try again).", mainKeyboard());
  }
}

// ---------------- NOTIFICATIONS (command still available) ----------------
bot.command("notifications", async (ctx) => {
  try {
    const userId = ctx.from.id;
    const { data: replies } = await supabase.from("notifications").select("*").eq("telegram_id", userId).eq("type", "reply").order("created_at", { ascending: false }).limit(NOTIF_PAGE_SIZE);
    const { data: reacts } = await supabase.from("notifications").select("*").eq("telegram_id", userId).eq("type", "reaction").order("created_at", { ascending: false }).limit(NOTIF_PAGE_SIZE);

    if ((!replies || replies.length === 0) && (!reacts || reacts.length === 0)) {
      return ctx.reply("🔕 No notifications yet.", mainKeyboard());
    }

    if (replies && replies.length) {
      await ctx.reply(`🔔 Recent replies (showing ${replies.length}):\n\n` + replies.map(n => n.message).join("\n\n"), Markup.inlineKeyboard([[Markup.button.callback("▶️ See more replies", `notif_replies_1`)]]));
    } else {
      await ctx.reply("🔔 No recent replies.", mainKeyboard());
    }
    if (reacts && reacts.length) {
      await ctx.reply(`🔁 Recent reactions (showing ${reacts.length}):\n\n` + reacts.map(n => n.message).join("\n\n"), Markup.inlineKeyboard([[Markup.button.callback("▶️ See more reactions", `notif_reacts_1`)]]));
    } else {
      await ctx.reply("🔁 No recent reactions.", mainKeyboard());
    }
  } catch (e) {
    console.error("notifications cmd error:", e);
    return ctx.reply("⚠️ Could not fetch notifications.", mainKeyboard());
  }
});

// ---------------- TEXT handler ----------------
bot.on("text", async (ctx) => {
  const text = (ctx.message && ctx.message.text) || "";
  const userId = ctx.from.id;
  const name = ctx.from.first_name || "friend";

  // pending search_prompt
  const pending = pendingAction.get(userId);
  if (pending && pending.type === "search_prompt") {
    pendingAction.delete(userId);
    return handleSearchCode(ctx, text.trim());
  }

  // pending reply text
  if (pending && pending.type === "reply_to_comment_text") {
    const commentId = pending.comment_id;
    try {
      const { data: created, error } = await insertReply({ commentId, replier: ctx.from, reply_text: text });
      pendingAction.delete(userId);
      if (error) throw error;
      await ctx.reply("✅ Text reply saved. Thank you!", mainKeyboard());
      const { data: comment } = await supabase.from("voice_comments").select("telegram_id, thread_id").eq("id", commentId).limit(1).maybeSingle();
      if (comment && comment.telegram_id && comment.telegram_id !== ctx.from.id) {
        const { data: thread } = await supabase.from("threads").select("social_link").eq("id", comment.thread_id).limit(1).maybeSingle();
        const short = encodeShortCode(commentId);
        const msg = `🗨️ New text reply on your comment by ${ctx.from.first_name || ctx.from.username}\nVideo: ${thread && thread.social_link ? thread.social_link : "(unknown)"}\nCode: ${short}\nSnippet: ${text.slice(0,120)}`;
        await supabase.from("notifications").insert([{ telegram_id: comment.telegram_id, type: "reply", message: msg, meta: { thread_id: comment.thread_id, comment_id: commentId, short_code: short } }]);
        try { await bot.telegram.sendMessage(comment.telegram_id, msg); if (short) await bot.telegram.sendMessage(comment.telegram_id, short); } catch (_) {}
      }
      return;
    } catch (e) {
      console.error("reply_to_comment_text handler error:", e);
      pendingAction.delete(userId);
      return ctx.reply("⚠️ Error saving reply.", mainKeyboard());
    }
  }

  // interface buttons
  if (text === "🎥 Add Comment") {
    pendingAction.set(userId, { type: "create_thread_public" });
    return ctx.reply("🎥 Send me the TikTok/YouTube link and you can add a voice comment for it.", mainKeyboard());
  }
  if (text === "➕ Add My Video") {
    pendingAction.set(userId, { type: "create_thread_owned" });
    return ctx.reply("➕ Send your TikTok/YouTube link to start tracking it. You'll be notified when people add voice comments.", mainKeyboard());
  }
  if (text === "🔖 Track Video") {
    try {
      const { data: threads } = await supabase.from("threads").select("*").eq("creator_telegram_id", userId).order("created_at", { ascending: false }).limit(100);
      if (!threads || threads.length === 0) return ctx.reply("You are not tracking any videos yet. Use ➕ Add My Video to add one.", mainKeyboard());
      for (const t of threads) {
        await ctx.reply(t.social_link, Markup.inlineKeyboard([
          [Markup.button.callback("🎧 Listen Comments", `listen_${t.id}_1`), Markup.button.callback("🎙 Add Voice Comment", `addvoice_${t.id}`)],
          [Markup.button.callback("🗑️ Delete Tracking", `delete_thread_${t.id}`)]
        ]));
      }
      return;
    } catch (e) {
      console.error("TrackVideo error:", e);
      return ctx.reply("Could not list tracked videos right now.", mainKeyboard());
    }
  }
  if (text === "🎧 Listen Comments") {
    pendingAction.set(userId, { type: "listen_prompt" });
    return ctx.reply("🎧 Send a TikTok/YouTube link or click a tracked video to listen to comments (paginated).", mainKeyboard());
  }
  if (text === "💬 My Comments") {
    try {
      const { data } = await supabase.from("voice_comments").select("id, thread_id, telegram_file_id, created_at").eq("telegram_id", userId).order("created_at", { ascending: false }).limit(200);
      if (!data || data.length === 0) return ctx.reply("You haven't posted any voice comments yet.", mainKeyboard());
      for (const c of data) {
        await ctx.reply(`Your comment id: ${c.id} (thread ${c.thread_id})`, Markup.inlineKeyboard([[Markup.button.callback("▶️ Play", `play_comment_${c.id}`), Markup.button.callback("🗑 Delete", `delete_comment_${c.id}`)]]));
      }
      return;
    } catch (e) {
      console.error("MyComments error:", e);
      return ctx.reply("Could not fetch your comments.", mainKeyboard());
    }
  }

  // NEW: Favorites button (text)
  if (text === "⭐ Favorites") {
    try {
      const comments = await listFavorites(userId);
      if (!comments || comments.length === 0) return ctx.reply("You have no favorites yet.", mainKeyboard());
      for (const c of comments) {
        try {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || "User"} — ${new Date(c.created_at).toLocaleString()}` });
        } catch (err) { console.error("fav voice send error:", err); }
        // send plain code only so it's copyable
        await ctx.reply(encodeShortCode(c.id));
        const counts = await getReactionCounts(c.id);
        const repliesCount = await getRepliesCount(c.id);
        await ctx.reply("Actions:",
          Markup.inlineKeyboard([
            [Markup.button.callback(`❤️ ${counts.heart}`, `react_${c.id}_heart`), Markup.button.callback(`😂 ${counts.laugh}`, `react_${c.id}_laugh`), Markup.button.callback(`👎 ${counts.dislike}`, `react_${c.id}_dislike`)],
            [Markup.button.callback("★ Favorite", `fav_${c.id}`), Markup.button.callback("📍 Set checkpoint", `checkpoint_${c.id}`)],
            [Markup.button.callback("💬 Reply (voice)", `replyvoice_${c.id}`), Markup.button.callback("✍️ Reply (text)", `replytext_${c.id}`)],
            [Markup.button.callback("▶️ Play", `play_comment_${c.id}`)]
          ])
        );
      }
      return;
    } catch (e) {
      console.error("Favorites listing error:", e);
      // If table missing, instruct user
      if (String(e).toLowerCase().includes("relation \"favorites\"") || String(e).toLowerCase().includes("does not exist")) {
        return ctx.reply("Favorites table not found. Run the SQL to create the table (I can re-send the SQL if needed).", mainKeyboard());
      }
      return ctx.reply("⚠️ Could not list favorites.", mainKeyboard());
    }
  }

  if (text === "🔎 Search") {
    pendingAction.set(userId, { type: "search_prompt" });
    return ctx.reply("🔎 Send the short code (e.g. 0000A9) or use /search CODE.", mainKeyboard());
  }

  // create thread flows
  const pend = pendingAction.get(userId);
  if (pend && (pend.type === "create_thread_public" || pend.type === "create_thread_owned")) {
    const url = extractFirstUrl(text);
    if (!url) return ctx.reply("I couldn't find a link. Please send a TikTok or YouTube URL.", mainKeyboard());
    try {
      await ensureUser(ctx.from);
      const thread = await createThread(url, pend.type === "create_thread_owned" ? userId : null);
      pendingAction.delete(userId);
      if (pend.type === "create_thread_owned") {
        await ctx.reply(`✅ Your video is tracked. We'll notify you when people add voice comments.\nVideo: ${thread.social_link}`, mainKeyboard());
      } else {
        await ctx.reply(`✅ Thread created. You can add comments now.\nVideo: ${thread.social_link}`, mainKeyboard());
      }
      await ctx.reply("Choose an action:", Markup.inlineKeyboard([[Markup.button.callback("🎙 Add Voice Comment", `addvoice_${thread.id}`), Markup.button.callback("🎧 Listen Comments", `listen_${thread.id}_1`)]]));
      return;
    } catch (e) {
      console.error("create_thread error:", e);
      pendingAction.delete(userId);
      return ctx.reply("⚠️ Couldn't create thread: " + (e.message || "DB error"), mainKeyboard());
    }
  }

  if (isSupportedLink(text)) {
    const url = extractFirstUrl(text);
    try {
      await ensureUser(ctx.from);
      const thread = await createThread(url, null);
      await ctx.reply(`✅ Thread created for: ${url}`, mainKeyboard());
      await ctx.reply("Choose an action:", Markup.inlineKeyboard([[Markup.button.callback("🎙 Add Voice Comment", `addvoice_${thread.id}`), Markup.button.callback("🎧 Listen Comments", `listen_${thread.id}_1`)]]));
      return;
    } catch (e) {
      console.error("direct createThread error:", e);
      return ctx.reply("⚠️ Database error while saving your link.", mainKeyboard());
    }
  }

  return ctx.reply(`Hi ${name}! I didn't detect a supported link. Press a button or send a TikTok/YouTube URL.`, mainKeyboard());
});

// ---------------- CALLBACKS ----------------
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery && ctx.callbackQuery.data;
  const userId = ctx.from.id;
  if (!data) {
    await ctx.answerCbQuery();
    return;
  }

  try {
    if (data.startsWith("addvoice_")) {
      const threadId = Number(data.split("addvoice_")[1]);
      if (!threadId) return ctx.answerCbQuery("Invalid thread id");
      pendingAction.set(userId, { type: "add_comment", thread_id: threadId });
      await ctx.answerCbQuery("Send your voice message now");
      return ctx.reply("🎙 Send your voice message now — it will attach to that thread.", mainKeyboard());
    }

    if (data.startsWith("listen_")) {
      const parts = data.split("_");
      const threadId = Number(parts[1]);
      const page = parts[2] ? Math.max(1, Number(parts[2])) : 1;
      if (!threadId) return ctx.answerCbQuery("Invalid thread id");
      const offset = (page - 1) * LISTEN_PAGE_SIZE;
      const { data: comments, error } = await supabase.from("voice_comments").select("*").eq("thread_id", threadId).order("created_at", { ascending: true }).range(offset, offset + LISTEN_PAGE_SIZE - 1);
      if (error) {
        console.error("listen fetch error:", error);
        await ctx.answerCbQuery();
        return ctx.reply("⚠️ Could not fetch comments.", mainKeyboard());
      }
      if (!comments || comments.length === 0) {
        await ctx.answerCbQuery();
        return ctx.reply("🎧 No voice comments yet for this video.", mainKeyboard());
      }
      for (const c of comments) {
        try {
          await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || "User"} — ${new Date(c.created_at).toLocaleString()}` });
        } catch (err) { console.error("replyWithVoice error:", err); }
        // send the code as a single-token message (copyable)
        await ctx.reply(encodeShortCode(c.id));
        const counts = await getReactionCounts(c.id);
        const repliesCount = await getRepliesCount(c.id);
        await ctx.reply("Actions:",
          Markup.inlineKeyboard([
            [Markup.button.callback(`❤️ ${counts.heart}`, `react_${c.id}_heart`), Markup.button.callback(`😂 ${counts.laugh}`, `react_${c.id}_laugh`), Markup.button.callback(`👎 ${counts.dislike}`, `react_${c.id}_dislike`)],
            [Markup.button.callback("★ Favorite", `fav_${c.id}`), Markup.button.callback("📍 Set checkpoint", `checkpoint_${c.id}`)],
            [Markup.button.callback("💬 Reply (voice)", `replyvoice_${c.id}`), Markup.button.callback("✍️ Reply (text)", `replytext_${c.id}`)],
            [Markup.button.callback("▶️ Play", `play_comment_${c.id}`)]
          ])
        );
      }
      const { count: totalCount } = await supabase.from("voice_comments").select("id", { count: "exact", head: true }).eq("thread_id", threadId);
      if (totalCount && offset + comments.length < totalCount) {
        await ctx.reply("▶️ See more", Markup.inlineKeyboard([[Markup.button.callback("▶️ See more", `listen_${threadId}_${page + 1}`)]]));
      }
      await ctx.answerCbQuery();
      return;
    }

    if (data.startsWith("react_")) {
      const [, sid, type] = data.split("_");
      const commentId = Number(sid);
      const allowed = new Set(["heart", "laugh", "dislike"]);
      if (!allowed.has(type)) return ctx.answerCbQuery("Unknown reaction");
      const { error } = await addReaction(commentId, userId, type);
      if (error) {
        console.error("addReaction error:", error);
        return ctx.answerCbQuery("Could not save reaction");
      }
      const counts = await getReactionCounts(commentId);
      await ctx.answerCbQuery(`Saved — ❤️ ${counts.heart}  😂 ${counts.laugh}  👎 ${counts.dislike}`);

      try {
        const { data: comment } = await supabase.from("voice_comments").select("id, thread_id, telegram_id, telegram_file_id").eq("id", commentId).limit(1).maybeSingle();
        if (comment && comment.telegram_id && comment.telegram_id !== userId) {
          const { data: thread } = await supabase.from("threads").select("social_link").eq("id", comment.thread_id).limit(1).maybeSingle();
          const short = encodeShortCode(commentId);
          const msg = `🔁 ${ctx.from.first_name || ctx.from.username || "Someone"} reacted (${type}) to your comment.\nVideo: ${thread ? thread.social_link : "(unknown)"}\nCode: ${short}`;
          await supabase.from("notifications").insert([{ telegram_id: comment.telegram_id, type: "reaction", message: msg, meta: { thread_id: comment.thread_id, comment_id: comment.id, short_code: short, reaction: type } }]);
          try {
            if (comment.telegram_file_id) {
              await bot.telegram.sendVoice(comment.telegram_id, comment.telegram_file_id, { caption: msg });
            } else {
              await bot.telegram.sendMessage(comment.telegram_id, msg);
            }
            // send only the code as plain text so it's immediately copyable
            await bot.telegram.sendMessage(comment.telegram_id, encodeShortCode(commentId));
          } catch (e) { /* ignore DM errors */ }
        }
      } catch (e) { console.error("notify reaction error:", e); }
      return;
    }

    if (data.startsWith("fav_")) {
      const commentId = Number(data.split("fav_")[1]);
      try {
        const res = await toggleFavorite(userId, commentId);
        await ctx.answerCbQuery(res.action === "added" ? "Favorite added" : "Favorite removed");
        return;
      } catch (e) {
        console.error("fav toggle error:", e);
        if (String(e).toLowerCase().includes("relation \"favorites\"") || String(e).toLowerCase().includes("does not exist")) {
          return ctx.answerCbQuery("Favorites table missing (run SQL).");
        }
        return ctx.answerCbQuery("Failed to toggle favorite");
      }
    }

    if (data.startsWith("checkpoint_")) {
      const commentId = Number(data.split("checkpoint_")[1]);
      try {
        await setCheckpoint(userId, commentId);
        await ctx.answerCbQuery("Checkpoint set. Use /checkpoint to jump to it.");
        return;
      } catch (e) {
        console.error("set checkpoint error:", e);
        return ctx.answerCbQuery("Failed to set checkpoint (run SQL?)");
      }
    }

    if (data.startsWith("replyvoice_")) {
      const commentId = Number(data.split("replyvoice_")[1]);
      pendingAction.set(userId, { type: "reply_to_comment_voice", comment_id: commentId });
      await ctx.answerCbQuery("Send a voice reply now");
      return ctx.reply("🎙 Send a voice reply — it will be saved.", mainKeyboard());
    }
    if (data.startsWith("replytext_")) {
      const commentId = Number(data.split("replytext_")[1]);
      pendingAction.set(userId, { type: "reply_to_comment_text", comment_id: commentId });
      await ctx.answerCbQuery("Send the reply text now");
      return ctx.reply("✍️ Send the text you want to save as a reply.", mainKeyboard());
    }

    if (data.startsWith("play_comment_")) {
      const commentId = Number(data.split("play_comment_")[1]);
      const { data: comment } = await supabase.from("voice_comments").select("*").eq("id", commentId).limit(1).maybeSingle();
      if (!comment) return ctx.answerCbQuery("Comment not found");
      await ctx.answerCbQuery();
      await ctx.replyWithVoice(comment.telegram_file_id, { caption: `Comment ${comment.id}` });
      // send copyable code only
      await ctx.reply(encodeShortCode(comment.id));
      return;
    }

    if (data.startsWith("delete_thread_")) {
      const threadId = Number(data.split("delete_thread_")[1]);
      const { data: thread } = await supabase.from("threads").select("*").eq("id", threadId).limit(1).maybeSingle();
      if (!thread) return ctx.answerCbQuery("Thread not found");
      if (thread.creator_telegram_id !== userId) return ctx.answerCbQuery("You are not owner");
      const { error } = await supabase.from("threads").delete().eq("id", threadId);
      if (error) return ctx.answerCbQuery("Delete failed");
      await ctx.answerCbQuery();
      return ctx.reply("✅ Tracked video deleted.", mainKeyboard());
    }

    // notifications pagination (same as before)
    if (data.startsWith("notif_replies_") || data.startsWith("notif_reacts_")) {
      const parts = data.split("_");
      const group = parts[1];
      const page = Number(parts[2]) || 1;
      const offset = (page - 1) * NOTIF_PAGE_SIZE;
      if (group === "replies") {
        const { data: rows } = await supabase.from("notifications").select("*").eq("telegram_id", userId).eq("type", "reply").order("created_at", { ascending: false }).range(offset, offset + NOTIF_PAGE_SIZE - 1);
        if (!rows || rows.length === 0) return ctx.answerCbQuery("No more reply notifications");
        await ctx.reply(`🔔 Replies (page ${page}):\n\n` + rows.map(r => r.message).join("\n\n"), Markup.inlineKeyboard([[Markup.button.callback("▶️ Next replies", `notif_replies_${page + 1}`)]]));
        return ctx.answerCbQuery();
      } else {
        const { data: rows } = await supabase.from("notifications").select("*").eq("telegram_id", userId).eq("type", "reaction").order("created_at", { ascending: false }).range(offset, offset + NOTIF_PAGE_SIZE - 1);
        if (!rows || rows.length === 0) return ctx.answerCbQuery("No more reaction notifications");
        await ctx.reply(`🔁 Reactions (page ${page}):\n\n` + rows.map(r => r.message).join("\n\n"), Markup.inlineKeyboard([[Markup.button.callback("▶️ Next reactions", `notif_reacts_${page + 1}`)]]));
        return ctx.answerCbQuery();
      }
    }

    await ctx.answerCbQuery();
  } catch (e) {
    console.error("callback_query error:", e);
    try { await ctx.answerCbQuery("Error"); } catch (_) {}
  }
});

// ---------------- VOICE handler ----------------
bot.on("voice", async (ctx) => {
  const userId = ctx.from.id;
  const p = pendingAction.get(userId);

  // reply voice flow
  if (p && p.type === "reply_to_comment_voice") {
    const commentId = p.comment_id;
    try {
      const voice = ctx.message.voice;
      const { data: created, error } = await insertReply({ commentId, replier: ctx.from, telegram_file_id: voice.file_id });
      pendingAction.delete(userId);
      if (error) throw error;
      await ctx.reply("✅ Voice reply saved. Thank you!", mainKeyboard());
      const { data: comment } = await supabase.from("voice_comments").select("telegram_id, thread_id").eq("id", commentId).limit(1).maybeSingle();
      if (comment && comment.telegram_id && comment.telegram_id !== ctx.from.id) {
        const { data: thread } = await supabase.from("threads").select("social_link").eq("id", comment.thread_id).limit(1).maybeSingle();
        const short = encodeShortCode(commentId);
        const msg = `🗨️ New voice reply on your comment by ${ctx.from.first_name || ctx.from.username}\nVideo: ${thread && thread.social_link ? thread.social_link : "(unknown)"}\nCode: ${short}`;
        await supabase.from("notifications").insert([{ telegram_id: comment.telegram_id, type: "reply", message: msg, meta: { thread_id: comment.thread_id, comment_id: commentId, short_code: short } }]);
        try {
          if (created && created.telegram_file_id) {
            await bot.telegram.sendVoice(comment.telegram_id, created.telegram_file_id, { caption: msg });
          } else {
            await bot.telegram.sendMessage(comment.telegram_id, msg);
          }
          // send only code as plain text in DM
          await bot.telegram.sendMessage(comment.telegram_id, encodeShortCode(commentId));
        } catch (e) { /* ignore DM errors */ }
      }
      return;
    } catch (e) {
      console.error("reply voice save error:", e);
      pendingAction.delete(userId);
      return ctx.reply("⚠️ Could not save voice reply.", mainKeyboard());
    }
  }

  // add voice to thread flow
  if (!p || p.type !== "add_comment") {
    return ctx.reply("No pending action found. Use 'Add Voice Comment' on a thread first.", mainKeyboard());
  }

  try {
    const threadId = p.thread_id;
    const { data: thread } = await supabase.from("threads").select("*").eq("id", threadId).limit(1).maybeSingle();
    if (!thread) {
      pendingAction.delete(userId);
      return ctx.reply("The thread couldn't be found.", mainKeyboard());
    }
    await ensureUser(ctx.from);
    const voice = ctx.message.voice;
    const payload = {
      thread_id: threadId,
      telegram_id: ctx.from.id,
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? null,
      telegram_file_id: voice.file_id,
      duration: voice.duration ?? 0,
    };
    const { data, error } = await supabase.from("voice_comments").insert([payload]).select();
    pendingAction.delete(userId);
    if (error) {
      console.error("voice_comments insert error:", error);
      return ctx.reply("❌ Couldn't save your voice comment: " + (error.message || "DB error"), mainKeyboard());
    }
    const created = data && data[0] ? data[0] : null;
    const short = created ? encodeShortCode(created.id) : null;
    await ctx.reply(`✅ Voice comment saved!` , mainKeyboard());
    // send only the code in a single message so it's easy to copy
    if (short) await ctx.reply(short);

    // notify owner if tracked
    if (thread.creator_telegram_id && thread.creator_telegram_id !== ctx.from.id) {
      try {
        const notifMsg = `🔔 New voice comment on your tracked video by ${ctx.from.first_name || ctx.from.username}\nVideo: ${thread.social_link}\nCode: ${short}`;
        await supabase.from("notifications").insert([{ telegram_id: thread.creator_telegram_id, type: "reply", message: notifMsg, meta: { thread_id: threadId, comment_id: created ? created.id : null, short_code: short } }]);
        try {
          if (created && created.telegram_file_id) {
            await bot.telegram.sendVoice(thread.creator_telegram_id, created.telegram_file_id, { caption: notifMsg });
          } else {
            await bot.telegram.sendMessage(thread.creator_telegram_id, notifMsg);
          }
          // DM: send only code
          if (short) await bot.telegram.sendMessage(thread.creator_telegram_id, short);
        } catch (err) { /* ignore DM errors */ }
      } catch (e) { console.error("notification creation error:", e); }
    }
    return;
  } catch (e) {
    console.error("voice handler error:", e);
    pendingAction.delete(userId);
    return ctx.reply("⚠️ An error occurred while saving your voice comment.", mainKeyboard());
  }
});

// favorites command (also available via keyboard)
bot.command("favorites", async (ctx) => {
  try {
    const comments = await listFavorites(ctx.from.id);
    if (!comments || comments.length === 0) return ctx.reply("You have no favorites yet.", mainKeyboard());
    for (const c of comments) {
      try {
        await ctx.replyWithVoice(c.telegram_file_id, { caption: `${c.first_name || c.username || "User"} — ${new Date(c.created_at).toLocaleString()}` });
      } catch (err) { console.error("fav voice send error:", err); }
      // send only the code
      await ctx.reply(encodeShortCode(c.id));
      const counts = await getReactionCounts(c.id);
      const repliesCount = await getRepliesCount(c.id);
      await ctx.reply("Actions:",
        Markup.inlineKeyboard([
          [Markup.button.callback(`❤️ ${counts.heart}`, `react_${c.id}_heart`), Markup.button.callback(`😂 ${counts.laugh}`, `react_${c.id}_laugh`), Markup.button.callback(`👎 ${counts.dislike}`, `react_${c.id}_dislike`)],
          [Markup.button.callback("★ Favorite", `fav_${c.id}`), Markup.button.callback("📍 Set checkpoint", `checkpoint_${c.id}`)],
          [Markup.button.callback("💬 Reply (voice)", `replyvoice_${c.id}`), Markup.button.callback("✍️ Reply (text)", `replytext_${c.id}`)],
          [Markup.button.callback("▶️ Play", `play_comment_${c.id}`)]
        ])
      );
    }
  } catch (e) {
    console.error("favorites cmd error:", e);
    if (String(e).toLowerCase().includes("relation \"favorites\"") || String(e).toLowerCase().includes("does not exist")) {
      return ctx.reply("Favorites table not found. Run the SQL to create the table (I can re-send the SQL if needed).", mainKeyboard());
    }
    return ctx.reply("⚠️ Could not list favorites.", mainKeyboard());
  }
});

// generic error logging + launch
bot.catch((err, ctx) => {
  console.error("Bot error:", err);
});

bot.launch().then(() => console.log("🚀 Bot is running...")).catch(e => console.error("Failed to launch:", e));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
