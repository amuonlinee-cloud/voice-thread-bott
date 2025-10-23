// index.js (ESM) - copy/paste this file to project root
import dotenv from "dotenv";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load .env (Render will use env vars too)
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT || 3000);
const LOCAL_POLLING = process.env.LOCAL_POLLING === "1" || process.env.LOCAL_POLLING === "true";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || process.env.SERVICE_URL || process.env.VERCEL_URL;

const app = express();
app.use(express.json({ limit: "10mb" }));

// helper to import bot module safely and detect what's exported
async function loadBotModule() {
  try {
    const mod = await import(path.join(__dirname, "src", "bot.js"));
    // prefer commonly used shapes:
    const maybeBot =
      mod.default ??
      mod.bot ??
      mod.telegraf ??
      mod.instance ??
      mod; // fallback
    return { mod, maybeBot };
  } catch (e) {
    console.error("❌ Failed to import ./src/bot.js", e);
    return { mod: null, maybeBot: null, err: e };
  }
}

(async () => {
  const { mod, maybeBot, err } = await loadBotModule();
  if (!maybeBot) {
    console.error("❌ Bot module didn't load. Exiting (check src/bot.js).", err);
    app.get("/", (req, res) => res.send("Bot module failed to load. Check logs."));
    app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
    return;
  }

  if (maybeBot && typeof maybeBot.startServer === "function") {
    try {
      await maybeBot.startServer(app, { LOCAL_POLLING });
      console.log("✅ Bot.startServer(app) ran (bot took control of HTTP endpoints).");
    } catch (e) {
      console.error("startServer failed:", e);
    }
  }

  if (maybeBot && typeof maybeBot.init === "function") {
    try {
      await maybeBot.init({ app, LOCAL_POLLING });
      console.log("✅ Bot.init() called.");
    } catch (e) {
      console.error("bot.init() failed:", e);
    }
  }

  const isTelegrafInstance = maybeBot && typeof maybeBot.handleUpdate === "function";

  // WEBHOOK MODE
  if (!LOCAL_POLLING) {
    if (!TELEGRAM_BOT_TOKEN) {
      console.error("❌ Running in webhook mode but TELEGRAM_BOT_TOKEN is missing.");
      process.exit(1);
    }
    if (!BASE_URL) {
      console.error("❌ Running in webhook mode but BASE_URL env is missing. Set BASE_URL to your service URL.");
      process.exit(1);
    }

    const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
    app.post(webhookPath, (req, res) => {
      // immediate ACK
      res.sendStatus(200);

      // process update async
      setImmediate(async () => {
        try {
          if (isTelegrafInstance) {
            await maybeBot.handleUpdate(req.body);
            return;
          }
          if (typeof maybeBot.handleWebhookUpdate === "function") {
            await maybeBot.handleWebhookUpdate(req.body);
            return;
          }
          if (typeof maybeBot.webhookHandler === "function") {
            await maybeBot.webhookHandler(req, req.body);
            return;
          }
          if (typeof maybeBot.processUpdate === "function") {
            await maybeBot.processUpdate(req.body);
            return;
          }
          console.warn("⚠️ Received update but bot module doesn't expose a recognized handler.");
        } catch (e) {
          console.error("Error processing update:", e);
        }
      });
    });

    console.log(`🌍 Webhook route registered: POST ${BASE_URL}${webhookPath}`);
  } else {
    // LOCAL POLLING mode — try to launch the bot if it's a Telegraf instance
    if (isTelegrafInstance) {
      try {
        if (typeof maybeBot.launch === "function") {
          await maybeBot.launch();
          console.log("🚀 Bot launched in polling mode (local dev).");
        } else {
          console.warn("⚠️ Bot looks like Telegraf but has no launch() method. Skipping launch.");
        }
      } catch (e) {
        console.error("Failed to launch bot for polling:", e);
      }
    } else {
      console.log("ℹ️ LOCAL_POLLING set but bot module is not a Telegraf instance or has no launch().");
    }
  }

  app.get("/", (req, res) => res.send("OK — voice-thread-bot"));

  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    if (LOCAL_POLLING) {
      console.log("ℹ️ Running in LOCAL_POLLING mode (polling).");
    } else {
      console.log("ℹ️ Running in WEBHOOK mode (expect Telegram to POST to /bot<TOKEN>).");
    }
  });
})();
