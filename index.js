// index.js
import dotenv from "dotenv";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, ".env") });

import "./src/bot.js"; // Import starts the bot automatically

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LOCAL_POLLING = process.env.LOCAL_POLLING === "1";

app.get("/", (req, res) => res.send("World Voice Comment Bot running ✅"));

// Optional webhook handling (only if not local polling)
if (!LOCAL_POLLING) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    console.error("❌ BASE_URL required for webhook mode");
    process.exit(1);
  }

  const webhookPath = `/bot${token}`;
  app.post(webhookPath, (req, res) => res.sendStatus(200));
  console.log(`🌍 Webhook set at ${baseUrl}${webhookPath}`);
}

app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
