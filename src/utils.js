// src/utils.js (ESM)
export const LINK_REGEX = /https?:\/\/(?:www\.)?(tiktok.com\/.+|vm.tiktok.com\/.+|youtube.com\/.+|youtu.be\/.+)/i;

export function extractSocialLink(text) {
  const match = text && text.match(LINK_REGEX);
  return match ? match[0] : null;
}

export function makeMainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🎥 Add Video" }, { text: "📊 Dashboard" }],
        [{ text: "🗂 My Comments" }, { text: "🔔 Notifications" }],
        [{ text: "❓ Help" }],
      ],
      resize_keyboard: true,
    },
  };
}
