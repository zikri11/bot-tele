import "dotenv/config";

export const config = {
  botToken: process.env.BOT_TOKEN || "",
  adminIds: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => !isNaN(id)),
  databaseUrl: process.env.DATABASE_URL || "",
  apiId: parseInt(process.env.API_ID || "0"),
  apiHash: process.env.API_HASH || "",
  botOwner: process.env.BOT_OWNER || "@Owner",
  botChannel: process.env.BOT_CHANNEL || "@Channel",
  botName: process.env.BOT_NAME || "Manager Nazwa",
  notifyBotToken: process.env.NOTIFY_BOT_TOKEN || "",
  notifyBotUsername: process.env.NOTIFY_BOT_USERNAME || "Notifikasi_Nazwa_bot",
};

// Validasi config
if (!config.botToken || config.botToken === "your_bot_token_here") {
  throw new Error("BOT_TOKEN belum diset di file .env");
}

if (config.adminIds.length === 0) {
  throw new Error("ADMIN_IDS belum diset di file .env");
}

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL belum diset di file .env");
}

if (!process.env.NOTIFY_BOT_TOKEN) {
  console.warn("⚠️ [WARNING] NOTIFY_BOT_TOKEN belum diset di .env");
}

if (!process.env.NOTIFY_BOT_USERNAME) {
  console.warn("⚠️ [WARNING] NOTIFY_BOT_USERNAME belum diset di .env");
}

// API_ID & API_HASH hanya wajib saat fitur Sewa Jasa digunakan (tidak throw di startup)
