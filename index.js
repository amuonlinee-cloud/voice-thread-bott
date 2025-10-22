// index.js
require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const LOCAL_POLLING = process.env.LOCAL_POLLING === "1";

console.log(`✅ Environment: LOCAL_POLLING=${LOCAL_POLLING}, BASE_URL=${BASE_URL}`);

// --- Load the bot ---
const { Telegraf } = require("telegraf");
const bot = new Telegraf(TOKEN);

// --- Basic /start command ---
bot.start((ctx) =>
  ctx.reply(
    `👋 Hi ${ctx.from.first_name || "there"}! Send a TikTok or YouTube link to start a voice thread.`
  )
);

// --- Example handler for messages ---
bot.on("message", (ctx) => {
  if (ctx.message.text && ctx.message.text.includes("http")) {
    ctx.reply("🔗 Got your link! Creating voice thread...");
  } else {
    ctx.reply("Please send a TikTok or YouTube link.");
  }
});

// --- Decide mode ---
if (LOCAL_POLLING) {
  bot.launch();
  console.log("🚀 Bot running in polling mode (local dev)");
} else {
  // --- Webhook mode for Render ---
  const webhookPath = `/bot${TOKEN}`;
  app.use(bot.webhookCallback(webhookPath));
  bot.telegram.setWebhook(`${BASE_URL}${webhookPath}`);

  app.get("/", (req, res) => res.send("✅ Voice Thread Bot is live via webhook"));
  console.log(`🌍 Webhook set at ${BASE_URL}${webhookPath}`);
}

app.listen(PORT, () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
