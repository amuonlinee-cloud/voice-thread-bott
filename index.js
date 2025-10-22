// index.js
import dotenv from "dotenv";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { Telegraf } from "telegraf";

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, ".env") });

// Bot setup
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("❌ TELEGRAM_BOT_TOKEN missing in .env");

const bot = new Telegraf(token);

// Simple test command
bot.start((ctx) => ctx.reply(`👋 Hi ${ctx.from.first_name}, welcome to World Voice Comment Bot!`));
bot.help((ctx) => ctx.reply("🆘 Send a TikTok or YouTube link to start a voice thread."));

// Express setup
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LOCAL_POLLING = process.env.LOCAL_POLLING === "1";

// Local dev (polling)
if (LOCAL_POLLING) {
  bot.launch();
  console.log("🚀 Bot running in polling mode (local dev)");
}

// Production (Render webhook)
else {
  const webhookPath = `/bot${token}`;
  app.post(webhookPath, (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  console.log(`🌍 Webhook endpoint ready at ${webhookPath}`);
}

app.get("/", (req, res) => res.send("✅ World Voice Comment Bot active"));

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
