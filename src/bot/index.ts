import { Bot, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { config } from "../config";
import adminCommands from "./commands/admin";
import userCommands from "./commands/user";
import { getActiveSubscriptions, formatRemaining, SERVICE_LABELS, ServiceType } from "../services/subscription";
import { handleScanGrup, handleBuatListGrup, handleListGrup } from "./commands/user/groups";
import { handleBroadcast } from "./commands/user/broadcast";
import { handleStatusBC } from "./commands/user/broadcast_status";
import { handleAturJeda } from "./commands/user/settings";
import { handleNotifikasi } from "./commands/user/notify";
import { handleBergabungGrup } from "./commands/user/join_groups";
import { handleControl } from "./commands/user/control";
import { handleRemoteMenu } from "./commands/user/remote";
import { getGrantedAccounts, getActiveAccount } from "../services/gramjs";
import { setNotifyEnabled } from "../services/userSettings";
import { pool } from "../db";

// Inisialisasi bot
export const bot = new Bot(config.botToken);
export const notifyBot = config.notifyBotToken ? new Bot(config.notifyBotToken) : null;

bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
if (notifyBot) {
  notifyBot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
}

// ─── Setup database tables (auto-create kalau belum ada) ──────────────────────
async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      duration_days INTEGER NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'unused',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      used_by BIGINT,
      used_at TIMESTAMP,
      created_by BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT,
      code_id INTEGER NOT NULL REFERENCES redeem_codes(id),
      code TEXT NOT NULL,
      service_type TEXT,
      duration_days INTEGER NOT NULL,
      activated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sub_status ON subscriptions(status);

    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      phone TEXT NOT NULL,
      session_string TEXT NOT NULL,
      label TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Migrasi multi-account: hapus UNIQUE constraint lama & tambah kolom baru
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS label TEXT;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS user_sessions_user_id_key;
    CREATE INDEX IF NOT EXISTS idx_us_user ON user_sessions(user_id);
    -- Beri label default dari nomor HP untuk akun yang belum punya label
    UPDATE user_sessions SET label = phone WHERE label IS NULL;
    -- Aktifkan SATU akun untuk tiap user yang belum punya akun aktif sama sekali
    UPDATE user_sessions SET is_active = 1
    WHERE id IN (
      SELECT DISTINCT ON (user_id) id FROM user_sessions
      WHERE user_id NOT IN (SELECT user_id FROM user_sessions WHERE is_active = 1)
      ORDER BY user_id, id ASC
    );
    -- Broadcast state per akun (pindah dari user_settings ke user_sessions)
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS broadcast_running INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS broadcast_list_id INTEGER;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS broadcast_message TEXT;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS broadcast_started_at TIMESTAMP;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS broadcast_round INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS broadcast_round_delay_minutes INTEGER;

    CREATE TABLE IF NOT EXISTS group_lists (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_list_items (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES group_lists(id),
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gl_user ON group_lists(user_id);
    CREATE INDEX IF NOT EXISTS idx_gli_list ON group_list_items(list_id);
    -- Tambah kolom account_id ke group_lists untuk pisah list per akun
    ALTER TABLE group_lists ADD COLUMN IF NOT EXISTS account_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_gl_account ON group_lists(account_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE,
      delay_mode TEXT,
      delay_seconds INTEGER,
      delay_min INTEGER,
      delay_max INTEGER,
      notify_enabled INTEGER NOT NULL DEFAULT 0,
      notify_targets TEXT DEFAULT '[]',
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Tambah kolom notify kalau belum ada (untuk DB yang sudah ada)
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_targets TEXT DEFAULT '[]';
    -- Tambah kolom broadcast state kalau belum ada
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS broadcast_running INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS broadcast_list_id INTEGER;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS broadcast_message TEXT;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS broadcast_started_at TIMESTAMP;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS broadcast_round INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS broadcast_round_delay_minutes INTEGER;

    CREATE TABLE IF NOT EXISTS remote_access_grants (
      id SERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      grantee_id BIGINT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES user_sessions(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS active_remote_accounts (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE,
      account_id INTEGER NOT NULL REFERENCES user_sessions(id),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

// Command /start
bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  const firstName = ctx.from?.first_name || "Pengguna";
  const isAdminUser = userId ? config.adminIds.includes(userId) : false;

  // Cek status berlangganan
  const activeSubs = userId ? await getActiveSubscriptions(userId) : [];
  const hasActiveSub = activeSubs.length > 0;

  // ─── Bangun teks pesan ───────────────────────────────────────────────────
  let message =
    `👋🏻 Hai!, *${firstName}*\n` +
    `Selamat datang di *${config.botName}*\n\n` +
    `Asisten Pengelolaan & Pengiriman Pesan Terjadwal\n\n` +
    `Owner: ${config.botOwner}\n` +
    `Channel: ${config.botChannel}\n`;

  if (hasActiveSub) {
    const sub = activeSubs[0];
    const serviceLabel = sub.serviceType
      ? SERVICE_LABELS[sub.serviceType as ServiceType]
      : "Belum dipilih";
    message +=
      `\n✅ *Status: Berlangganan Aktif*\n` +
      `Layanan: ${serviceLabel}\n` +
      `Sisa waktu: *${formatRemaining(sub.expiresAt)}*\n`;
  } else {
    message += `\n❌ *Status: Tidak Berlangganan*\n`;
  }

  // ─── Bangun inline keyboard ──────────────────────────────────────────────
  const keyboard = new InlineKeyboard();

  if (isAdminUser) {
    keyboard
      .text("🔐 Panel Admin", "start:admin")
      .text("🎫 Generate Kode", "start:generate")
      .row()
      .text("📋 List Kode", "start:listcodes")
      .row();
  }

  keyboard
    .text("🎟 Redeem Kode", "start:redeem")
    .text("📊 Status", "start:status")
    .row()
    .text("🔑 Login Akun", "start:login")
    .text("🚫 Hentikan Sub", "start:endsub");

  const hasRemoteAccess = userId ? (await getGrantedAccounts(userId)).length > 0 : false;

  let hasFeatures = false;
  let isRemoteMode = false;
  if (userId) {
    const remoteActive = await getActiveAccount(userId);
    if (remoteActive && remoteActive.label.includes("[REMOTE]")) {
      isRemoteMode = true;
    }
  }

  if (hasActiveSub || isRemoteMode) {
    hasFeatures = true;
  }

  const keyboardRows = [];
  if (hasFeatures) {
    keyboardRows.push([{ text: "📡 Scan Grup" }, { text: "📋 Buat List Grup" }]);
    keyboardRows.push([{ text: "🗂 List Grup" }, { text: "📣 Broadcast" }]);
    keyboardRows.push([{ text: "⚙️ Atur Jeda" }, { text: "🔔 Notifikasi" }]);
    
    const row4 = [{ text: "🚪 Bergabung Grup" }];
    if (!isRemoteMode) {
      row4.push({ text: "🎛 Control" });
    }
    keyboardRows.push(row4);

    keyboardRows.push([{ text: "📊 Status BC" }]);
  }
  
  if (hasRemoteAccess) {
    if (keyboardRows.length === 0) {
      keyboardRows.push([{ text: "🕹 Remote Akses" }]);
    } else {
      keyboardRows[keyboardRows.length - 1].push({ text: "🕹 Remote Akses" });
    }
  }

  const replyKeyboard = keyboardRows.length > 0
    ? {
        keyboard: keyboardRows,
        resize_keyboard: true,
        is_persistent: true,
      }
    : { remove_keyboard: true as const };

  await ctx.reply(message, {
    parse_mode: "Markdown",
    reply_markup: replyKeyboard,
  });

  // Kirim inline keyboard sebagai pesan terpisah agar tidak bentrok
  await ctx.reply("Pilih menu:", { reply_markup: keyboard });
});

// Register admin commands
bot.use(adminCommands);
// Register user commands
bot.use(userCommands);

// ─── Callback: tombol-tombol di pesan /start ──────────────────────────────────
bot.callbackQuery("start:admin", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Gunakan /admin untuk membuka panel admin.");
});

bot.callbackQuery("start:generate", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Gunakan /generate untuk membuat kode redeem baru.");
});

bot.callbackQuery("start:listcodes", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Gunakan /listcodes untuk melihat daftar kode.");
});

bot.callbackQuery("start:redeem", async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCallbackQuery();

  // Import waitingRedeemInput dan set user ke mode input
  const { waitingRedeemInput } = await import("./commands/user/redeem");
  waitingRedeemInput.add(userId);

  await ctx.reply(
    "🎟 *Redeem Kode*\n\nKirim kode redeem Anda:",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("❌ Batal", "redeem:cancel_input"),
    }
  );
});

bot.callbackQuery("start:status", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const { buildStatusText } = await import("./commands/user/status");
  const text = await buildStatusText(userId);
  await ctx.reply(text, { parse_mode: "Markdown" });
});

bot.callbackQuery("start:login", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Gunakan /login untuk menghubungkan akun Telegram Anda.");
});

bot.callbackQuery("start:endsub", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Gunakan /endsub untuk menghentikan langganan aktif Anda.");
});

// ─── Callback: Tombol Quick Mute Notifikasi ──────────────────────────────────
const handleQuickMute = async (ctx: any) => {
  const userId = ctx.from?.id;
  if (userId) {
    await setNotifyEnabled(userId, false);
  }
  await ctx.answerCallbackQuery("Notifikasi dinonaktifkan.");
  await ctx.reply(
    "🔕 Notifikasi berhasil dinonaktifkan. Anda dapat mengaktifkannya kembali melalui menu di Bot Utama kapan saja."
  );
};

bot.callbackQuery("ntf:quick_mute", handleQuickMute);
if (notifyBot) {
  notifyBot.callbackQuery("ntf:quick_mute", handleQuickMute);
}

// ─── Helper: cek langganan aktif sebelum akses fitur ─────────────────────────
async function checkActiveSub(ctx: any): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const subs = await getActiveSubscriptions(userId);
  if (subs.length > 0) return true;

  const remoteActive = await getActiveAccount(userId);
  if (remoteActive && remoteActive.label.includes("[REMOTE]")) {
    return true; // Bypass sub check
  }

  // Langganan habis — hapus keyboard dan beri tahu user
  await ctx.reply(
    "❌ *Akses Ditolak*\n\n" +
      "Langganan Anda sudah habis atau belum aktif, dan Anda tidak sedang mengontrol akun remote.\n\n" +
      "Gunakan `/redeem <KODE>` untuk mengaktifkan layanan.",
    {
      parse_mode: "Markdown",
      reply_markup: { remove_keyboard: true },
    }
  );
  return false;
}

// ─── Fallback: pesan/command tidak dikenal ────────────────────────────────────
bot.on("message", async (ctx) => {
  const userId = ctx.from?.id;
  const firstName = ctx.from?.first_name || "Pengguna";
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";

  // ── Tangkap tombol reply keyboard (semua butuh langganan aktif) ──
  const replyKeyboardButtons = [
    "📡 Scan Grup", "📋 Buat List Grup", "🗂 List Grup",
    "📣 Broadcast", "⚙️ Atur Jeda", "🔔 Notifikasi",
    "🚪 Bergabung Grup", "🎛 Control", "📊 Status BC",
    "🕹 Remote Akses"
  ];

  if (text && replyKeyboardButtons.includes(text)) {
    if (text === "🕹 Remote Akses") {
       await handleRemoteMenu(ctx); return;
    }

    if (!(await checkActiveSub(ctx))) return;

    if (text === "📡 Scan Grup") { await handleScanGrup(ctx); return; }
    if (text === "📋 Buat List Grup") { await handleBuatListGrup(ctx); return; }
    if (text === "🗂 List Grup") { await handleListGrup(ctx); return; }
    if (text === "📣 Broadcast") { await handleBroadcast(ctx); return; }
    if (text === "⚙️ Atur Jeda") { await handleAturJeda(ctx); return; }
    if (text === "🔔 Notifikasi") { await handleNotifikasi(ctx); return; }
    if (text === "🚪 Bergabung Grup") { await handleBergabungGrup(ctx); return; }
    if (text === "🎛 Control") {
      const remoteActive = await getActiveAccount(userId!);
      if (remoteActive && remoteActive.label.includes("[REMOTE]")) {
        await ctx.reply("⚠️ Menu Control tidak tersedia saat menggunakan Akun Remote. Kembalilah ke akun sendiri melalui menu 🕹 Remote Akses.");
        return;
      }
      await handleControl(ctx);
      return;
    }
    if (text === "📊 Status BC") { await handleStatusBC(ctx); return; }
  }

  // ── Pesan tidak dikenal ──
  await ctx.reply(
    `👋🏻 Hai!, *${firstName}*\n` +
      `Selamat datang di *${config.botName}*\n\n` +
      `Asisten Pengelolaan & Pengiriman Pesan Terjadwal\n\n` +
      `Owner: ${config.botOwner}\n` +
      `Channel: ${config.botChannel}\n\n` +
      `/start - untuk memulai`,
    { parse_mode: "Markdown" }
  );
});

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// ─── Global Error Handler untuk GramJS ───────────────────────────────────────
// Mencegah bot crash jika GramJS mengalami masalah koneksi di background (updateLoop)
process.on("unhandledRejection", (reason: any) => {
  const msg = String(reason?.message || reason);
  const stack = String(reason?.stack || "");
  if (
    msg.includes("TIMEOUT") ||
    msg.includes("connection closed") ||
    msg.includes("WebSocket connection failed") ||
    msg.includes("AUTH_KEY_UNREGISTERED") ||
    msg.includes("AUTH_KEY_DUPLICATED") ||
    stack.includes("telegram/") ||
    stack.includes("telegram\\") ||
    stack.includes("MTProto")
  ) {
    console.warn("⚠️ [GramJS] Diabaikan unhandled rejection (masalah koneksi/auth):", msg);
  } else {
    console.error("❌ Unhandled Rejection:", reason);
  }
});

process.on("uncaughtException", (err) => {
  const msg = String(err?.message || err);
  const stack = String(err?.stack || "");
  if (
    msg.includes("TIMEOUT") ||
    msg.includes("connection closed") ||
    msg.includes("WebSocket connection failed") ||
    msg.includes("AUTH_KEY_UNREGISTERED") ||
    msg.includes("AUTH_KEY_DUPLICATED") ||
    stack.includes("telegram/") ||
    stack.includes("telegram\\") ||
    stack.includes("MTProto")
  ) {
    console.warn("⚠️ [GramJS] Diabaikan uncaught exception (masalah koneksi/auth):", msg);
  } else {
    console.error("❌ Uncaught Exception:", err);
  }
});

// Start bot
async function main() {
  console.log("🤖 Bot starting...");
  console.log("📦 Setting up database...");
  await setupDatabase();
  console.log("✅ Database ready");

  // Resume broadcast yang sedang berjalan sebelum bot restart
  const { getAllRunningBroadcastAccounts } = await import("../services/gramjs");
  const { resumeBroadcastForAccount } = await import("../services/broadcast");
  const runningAccounts = await getAllRunningBroadcastAccounts();
  if (runningAccounts.length > 0) {
    console.log(`🔄 Resuming broadcast for ${runningAccounts.length} account(s)...`);
    for (const { userId, accountId } of runningAccounts) {
      resumeBroadcastForAccount(userId, accountId, bot, async () => {}).catch((err: unknown) => {
        console.error(`[resume] Failed for account ${accountId}:`, err);
      });
    }
  }

  if (notifyBot) {
    try {
      notifyBot.command("start", async (ctx) => {
        await ctx.reply(
          `👋 *Halo, ${ctx.from?.first_name || "Pengguna"}!*\n\n` +
          `Saya adalah *Notifikasi Bot ${config.botName}* (@${config.notifyBotUsername}).\n` +
          `Saya akan mengirimkan laporan broadcast Anda langsung ke sini.\n\n` +
          `Pastikan status bot ini tetap aktif agar notifikasi broadcast dapat terkirim!`,
          { parse_mode: "Markdown" }
        );
      });

      notifyBot.start({
        onStart: (botInfo) => {
          console.log(`✅ Notification Bot @${botInfo.username} is running!`);
        },
      }).catch((err) => {
        console.error("Failed to start notification bot:", err);
      });
    } catch (err) {
      console.error("Failed to initialize notification bot:", err);
    }
  }

  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot @${botInfo.username} is running!`);
      console.log(`👑 Admin IDs: ${config.adminIds.join(", ")}`);
    },
  });
}

main().catch(async (err) => {
  const errMsg = String(err?.message || err);
  console.error('❌ Failed to start bot:', err);
  if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
    console.error('⚠️ [CRITICAL] Token bot tidak valid atau telah dicabut (401 Unauthorized). Menunda proses selama 30 detik untuk mencegah PM2 crash-loop...');
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  process.exit(1);
});
