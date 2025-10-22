// test_db.mjs — safer test: use inserted thread id for voice comment
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY in .env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

(async () => {
  console.log("Checking threads table...");
  const sel = await supabase.from("threads").select("id, social_link").order("id", { ascending: false }).limit(5);
  console.log("Existing threads (top 5):", sel.data);

  console.log("\nInserting a new thread (sample link)...");
  const sampleLink = "https://example.com/test-video-" + Date.now();
  const insertThread = await supabase
    .from("threads")
    .insert([{ social_link: sampleLink, creator_telegram_id: 999999999 }])
    .select();
  console.log("threads insert -> error:", insertThread.error);
  console.log("threads insert -> data:", insertThread.data);

  // pick a thread id to reference
  const threadId = insertThread.data && insertThread.data[0] ? insertThread.data[0].id : (sel.data && sel.data[0] ? sel.data[0].id : null);
  if (!threadId) {
    console.error("No thread id available to test voice_comments insert. Create a thread first.");
    process.exit(1);
  }
  console.log("\nUsing threadId =", threadId);

  console.log("\nInserting a test voice_comment referencing that thread id...");
  const insertVoice = await supabase
    .from("voice_comments")
    .insert([{
      thread_id: threadId,
      telegram_id: 999999999,
      username: 'testuser',
      first_name: 'Test',
      telegram_file_id: 'test-file-id'
    }])
    .select();
  console.log("voice_comments insert -> status:", insertVoice.status);
  console.log("voice_comments insert -> error:", insertVoice.error);
  console.log("voice_comments insert -> data:", insertVoice.data);

  console.log("\nDone.");
  process.exit(0);
})();
