// index.js (paste this file, ESM)
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
const BASE_URL = process.env.BASE_URL || process.env.BASE_URL || process.env.SERVICE_URL;

const app = express();
app.use(express.json({ limit: "10mb" }));

// helper to import bot module safely and detect what's exported
async function loadBotModule() {
  try {
    const mod = await import(path.join(__dirname, "src", "bot.js"));
    // prefer commonly used shapes:
    // default export, named export 'bot', named export 'default', named 'init' or 'startServer'
    const maybeBot =
      mod.default ??
      mod.bot ??
      mod.telegraf ??
      mod.instance ??
      mod; // fallback to whole module so we can inspect it

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
    // still start a lightweight server so Render health checks pass
    app.get("/", (req, res) => res.send("Bot module failed to load. Check logs."));
    app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
    return;
  }

  // If module exported an object which contains a startServer(app) or init function, call it:
  if (maybeBot && typeof maybeBot.startServer === "function") {
    try {
      await maybeBot.startServer(app, { LOCAL_POLLING });
      console.log("✅ Bot.startServer(app) ran (bot took control of HTTP endpoints).");
    } catch (e) {
      console.error("startServer failed:", e);
    }
  }

  // If module exported an init() function, call it (best-effort)
  if (maybeBot && typeof maybeBot.init === "function") {
    try {
      await maybeBot.init({ app, LOCAL_POLLING });
      console.log("✅ Bot.init() called.");
    } catch (e) {
      console.error("bot.init() failed:", e);
    }
  }

  // Detect if maybeBot is a Telegraf-like instance (has handleUpdate) —
  // that allows webhook handling without calling .launch() (avoid polling <-> webhook conflicts).
  const isTelegrafInstance = maybeBot && typeof maybeBot.handleUpdate === "function";

  // WEBHOOK MODE: set up route that immediately responds 200, then processes update async
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
      // immediate ACK to Telegram
      res.sendStatus(200);

      // process update asynchronously so we don't block the response
      setImmediate(async () => {
        try {
          // if Telegraf instance -> call handleUpdate
          if (isTelegrafInstance) {
            await maybeBot.handleUpdate(req.body);
            return;
          }

          // if module exports a function to accept raw updates (e.g. handleUpdate) - try common names
          if (typeof maybeBot.handleWebhookUpdate === "function") {
            await maybeBot.handleWebhookUpdate(req.body);
            return;
          }

          // if the module exported a 'webhookHandler' function, call it
          if (typeof maybeBot.webhookHandler === "function") {
            await maybeBot.webhookHandler(req, req.body);
            return;
          }

          // fall back: if module exports a 'processUpdate' function
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
        // Launch only if a launch() function exists. We pass sensible options if available.
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

  // If the module exported a Telegraf instance but you DO NOT want to call launch()
  // in webhook mode you should not call bot.launch() — above respects that.

  // Basic root health endpoint
  app.get("/", (req, res) => res.send("OK — voice-thread-bot"));

  // start express server
  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    if (LOCAL_POLLING) {
      console.log("ℹ️ Running in LOCAL_POLLING mode (polling).");
    } else {
      console.log("ℹ️ Running in WEBHOOK mode (expect Telegram to POST to /bot<TOKEN>).");
    }
  });
})();


