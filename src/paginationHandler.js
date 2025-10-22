// src/paginationHandler.js (ESM)
const LISTEN_PAGE_SIZE = parseInt(process.env.LISTEN_PAGE_SIZE || "15", 10);

export const pageSize = LISTEN_PAGE_SIZE;

export function makeListenInlineKeyboard(thread_id, hasMore, nextPage = 2) {
  const buttons = [];
  buttons.push([
    { text: "🎙 Add Voice Comment", callback_data: `add_voice_${thread_id}` },
    { text: "🔁 Refresh", callback_data: `listen_${thread_id}_page_1` },
  ]);
  if (hasMore) {
    buttons.push([{ text: "▶️ Load More", callback_data: `listen_${thread_id}_page_${nextPage}` }]);
  }
  return { reply_markup: { inline_keyboard: buttons } };
}

export function makeCommentInlineButtons(comment) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "❤️ Like", callback_data: `like_${comment.id}` },
          { text: "👎 Dislike", callback_data: `dislike_${comment.id}` },
          { text: "💬 Reply", callback_data: `reply_${comment.id}` },
        ],
      ],
    },
  };
}
