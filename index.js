// index.js (ESM) — paste exactly, overwrite existing file
import dotenv from "dotenv";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load .env
dotenv.config({ path: path.join(__dirname, ".env") });

// import bot module (should export a Telegraf instance as default)
import bot from "./src/bot.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const LOCAL_POLLING = (process.env.LOCAL_POLLING === "1" || process.env.LOCAL_POLLING === "true");

// root
app.get("/", (req, res) => res.send("OK — voice-thread-bot"));

// webhook path (only when not using local polling)
if (!LOCAL_POLLING) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = process.env.BASE_URL;
  if (!token || !baseUrl) {
    console.error("❌ BASE_URL and TELEGRAM_BOT_TOKEN are required in webhook mode");
    // don't exit here — let user fix env in Render
  } else {
    const webhookPath = `/bot${token}`;
    // Ack immediately to Telegram, then hand the body to bot (best-effort)
    app.post(webhookPath, (req, res) => {
      res.sendStatus(200); // immediate ACK to Telegram
      try {
        if (bot && typeof bot.handleUpdate === "function") {
          // Telegraf: pass update to bot
          bot.handleUpdate(req.body);
        } else if (typeof bot === "function") {
          bot(req.body); // fallback
        }
      } catch (e) {
        console.error("handleUpdate error", e);
      }
    });
    console.log(`🌍 Webhook endpoint: ${baseUrl}${webhookPath}`);
  }
}

// start server
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  if (LOCAL_POLLING) {
    // If bot exports a Telegraf instance, start polling
    if (bot && typeof bot.launch === "function") {
      try {
        await bot.launch();
        console.log("🚀 Bot launched in polling mode (LOCAL_POLLING=true)");
      } catch (e) {
        console.error("bot.launch err", e);
      }
    } else {
      console.log("⚠️ Bot instance not found or missing launch()");
    }
  } else {
    console.log("ℹ️ Running in webhook mode (LOCAL_POLLING=false)");
  }
});
