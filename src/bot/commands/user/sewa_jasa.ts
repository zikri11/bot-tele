import { Composer, Context, InlineKeyboard } from "grammy";
import {
  startLogin,
  submitOtp,
  submitPassword,
  saveSession,
  clearLoginState,
  getLoginStep,
  hasSession,
  scanGroups,
  deleteSession,
  getPhone,
  GroupInfo,
} from "../../../services/gramjs";
import {
  sewaJasaDashboard,
  cancelLoginMenu,
  requestContactKeyboard,
  removeKeyboard,
  afterScanMenu,
} from "../../keyboards/user";
import { getActiveSubscriptions } from "../../../services/subscription";
import { config } from "../../../config";

const composer = new Composer();

// ─── In-memory: track user yang menunggu konfirmasi nomor ────────────────────
// userId -> nomor HP yang akan dikonfirmasi
const pendingConfirm = new Map<number, string>();

// ─── Helper: cek API credentials sudah diset ─────────────────────────────────
function isApiConfigured(): boolean {
  return config.apiId > 0 && !!config.apiHash && config.apiHash !== "your_api_hash_here";
}

// ─── Callback: tombol "🔑 Login Sekarang" dari afterRedeemMenu ───────────────
composer.callbackQuery("sj:trigger_login", async (ctx) => {
  const userId = ctx.from.id;

  if (!isApiConfigured()) {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "⚠️ *Fitur login belum dikonfigurasi*\n\n" +
        "Admin perlu mengisi `API_ID` dan `API_HASH` di file `.env`.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (await hasSession(userId)) {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "✅ Akun Anda sudah terhubung.\n\nGunakan tombol di bawah:",
      { reply_markup: sewaJasaDashboard() }
    );
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🔑 *Login Akun Telegram*\n\n" +
      "⚠️ *PENTING DEMI KEAMANAN AKUN:*\n" +
      "Pastikan akun Anda *SUDAH MENGAKTIFKAN 2FA (Verifikasi 2 Langkah)* di aplikasi resmi Telegram sebelum login agar akun aman dari pembatasan/limit otomatis.\n\n" +
      "Tap tombol di bawah untuk membagikan nomor HP Anda.",
    { parse_mode: "Markdown", reply_markup: requestContactKeyboard() }
  );
});

// ─── Callback: user memilih Sewa Jasa (legacy — redirect ke login) ────────────
composer.callbackQuery(/^svc:(\d+):sewa_jasa$/, async (ctx) => {
  const userId = ctx.from.id;

  if (await hasSession(userId)) {
    await ctx.editMessageText(
      "✅ *Userbot Dashboard*\n\n" +
        "Akun Telegram Anda sudah terhubung.\n" +
        "Pilih aksi yang ingin dilakukan:",
      { parse_mode: "Markdown", reply_markup: sewaJasaDashboard() }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (!isApiConfigured()) {
    await ctx.editMessageText(
      "⚠️ *Fitur login belum dikonfigurasi*\n\n" +
        "Admin perlu mengisi `API_ID` dan `API_HASH` di file `.env`.",
      { parse_mode: "Markdown" }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🔑 *Login Akun Telegram*\n\n" +
      "⚠️ *PENTING DEMI KEAMANAN AKUN:*\n" +
      "Pastikan akun Anda *SUDAH MENGAKTIFKAN 2FA (Verifikasi 2 Langkah)* di aplikasi resmi Telegram sebelum login agar akun aman dari pembatasan/limit otomatis.\n\n" +
      "Tap tombol di bawah untuk membagikan nomor HP Anda.",
    { parse_mode: "Markdown", reply_markup: requestContactKeyboard() }
  );
});

// ─── Handler: terima kontak dari user ────────────────────────────────────────
composer.on("message:contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

  // Pastikan kontak yang dibagikan adalah milik user sendiri
  if (contact.user_id !== userId) {
    await ctx.reply("⚠️ Harap bagikan nomor HP Anda sendiri, bukan kontak orang lain.", {
      reply_markup: removeKeyboard(),
    });
    return;
  }

  const phone = contact.phone_number.startsWith("+")
    ? contact.phone_number
    : `+${contact.phone_number}`;

  // Hapus reply keyboard
  await ctx.reply("✅ Nomor diterima.", { reply_markup: removeKeyboard() });

  // Simpan untuk konfirmasi
  pendingConfirm.set(userId, phone);

  // Tampilkan konfirmasi dengan inline keyboard
  const confirmMenu = new InlineKeyboard()
    .text("✅ Ya, Lanjutkan", `sj:confirm_login:${encodePhone(phone)}`)
    .row()
    .text("❌ Batal", "sj:cancel_login");

  await ctx.reply(
    `📱 *Konfirmasi Login*\n\n` +
      `Nomor: \`${phone}\`\n\n` +
      `⚠️ *PENTING DEMI KEAMANAN AKUN:*\n` +
      `Pastikan akun Anda *SUDAH MENGAKTIFKAN 2FA (Verifikasi 2 Langkah)* di aplikasi resmi Telegram sebelum login agar akun aman dari pembatasan/limit otomatis.\n\n` +
      `Kami akan mengirim kode OTP ke nomor ini melalui Telegram.\n` +
      `Lanjutkan?`,
    { parse_mode: "Markdown", reply_markup: confirmMenu }
  );
});

// ─── Callback: konfirmasi login ───────────────────────────────────────────────
composer.callbackQuery(/^sj:confirm_login:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = decodePhone(ctx.match![1]);

  await ctx.editMessageText(
    `⏳ *Mengirim kode OTP ke ${phone}...*\n\nMohon tunggu.`,
    { parse_mode: "Markdown" }
  );
  await ctx.answerCallbackQuery();

  const result = await startLogin(userId, phone);

  if (!result.success) {
    await ctx.editMessageText(
      `❌ *Gagal mengirim OTP*\n\n${result.message}\n\n` +
        `Gunakan /login untuk mencoba lagi.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.editMessageText(
    "📱 *Kode OTP Terkirim\\!*\n\n" +
      `Cek pesan Telegram Anda untuk nomor \`${phone}\`\\.\n\n` +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "⚠️ *PENTING — Tambahkan spasi antar angka\\!*\n" +
      "Jika kode OTP Anda `12345`, kirim seperti ini:\n" +
      "`1 2 3 4 5`\n\n" +
      "Cek kode OTP di: [KLIK DISINI](tg://resolve?phone=42777)\n\n" +
      "━━━━━━━━━━━━━━━━━━━━\n" +
      "Kirim kode OTP Anda di bawah ini:",
    {
      parse_mode: "MarkdownV2",
      reply_markup: cancelLoginMenu(),
    }
  );
});

// ─── Message handler: tangkap OTP dan password ───────────────────────────────
composer.on("message:text", async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // Skip command
  if (text.startsWith("/")) return next();

  const step = getLoginStep(userId);

  // Tidak sedang dalam flow login
  if (step === "idle" || step === "done") return next();

  // ── Step: input OTP ──
  if (step === "waiting_otp") {
    // Strip semua spasi — user kirim format "1 2 3 4 5"
    const otpClean = text.replace(/\s+/g, "");

    if (!/^\d{4,6}$/.test(otpClean)) {
      await ctx.reply(
        "⚠️ Format kode tidak valid.\n\n" +
          "Kirim kode dengan spasi antar angka.\n" +
          "Contoh: `1 2 3 4 5`",
        { parse_mode: "Markdown", reply_markup: cancelLoginMenu() }
      );
      return;
    }

    const loadingMsg = await ctx.reply("⏳ Memverifikasi kode OTP...");
    const result = await submitOtp(userId, otpClean);
    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (result.status === "success") {
      await handleLoginSuccess(ctx, userId, result.sessionString);
      return;
    }
    if (result.status === "need_password") {
      await ctx.reply(
        "🔐 *Verifikasi Dua Langkah Aktif*\n\n" +
          "Akun Anda menggunakan verifikasi dua langkah (2FA).\n" +
          "Kirim *kata sandi* 2FA Anda:",
        { parse_mode: "Markdown", reply_markup: cancelLoginMenu() }
      );
      return;
    }
    await ctx.reply(`❌ ${result.message}`, { reply_markup: cancelLoginMenu() });
    return;
  }

  // ── Step: input password 2FA ──
  if (step === "waiting_password") {
    const loadingMsg = await ctx.reply("⏳ Memverifikasi password...");
    const result = await submitPassword(userId, text);
    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    if (result.success && result.sessionString) {
      await handleLoginSuccess(ctx, userId, result.sessionString);
      return;
    }
    await ctx.reply(`❌ ${result.message}`, { reply_markup: cancelLoginMenu() });
    return;
  }

  return next();
});

// ─── Helper: setelah login berhasil ──────────────────────────────────────────
async function handleLoginSuccess(
  ctx: Context,
  userId: number,
  sessionString: string
) {
  const phone = getPhone(userId) || "unknown";
  await saveSession(userId, phone, sessionString);
  clearLoginState(userId);
  pendingConfirm.delete(userId);



  const { countAccounts } = await import("../../../services/gramjs");
  const total = await countAccounts(userId);

  await ctx.reply(
    `✅ *Login Berhasil!*\n\n` +
      `Akun \`${phone}\` berhasil terhubung.\n` +
      `Total akun terhubung: *${total}*\n\n` +
      `Pilih aksi yang ingin dilakukan:`,
    { parse_mode: "Markdown", reply_markup: sewaJasaDashboard() }
  );
}

// ─── Callback: batal login ────────────────────────────────────────────────────
composer.callbackQuery("sj:cancel_login", async (ctx) => {
  const userId = ctx.from.id;
  clearLoginState(userId);
  pendingConfirm.delete(userId);

  await ctx.editMessageText("❌ Proses login dibatalkan.\n\nGunakan /login untuk mencoba lagi.");
  await ctx.answerCallbackQuery("Login dibatalkan.");
});

// ─── Callback: dashboard ──────────────────────────────────────────────────────
composer.callbackQuery("sj:dashboard", async (ctx) => {
  const userId = ctx.from.id;

  if (!(await hasSession(userId))) {
    await ctx.editMessageText(
      "⚠️ Akun belum terhubung.\n\nGunakan /login untuk menghubungkan akun."
    );
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.editMessageText(
    "🔑 *Sewa Jasa - Dashboard*\n\n" +
      "Akun Telegram Anda sudah terhubung.\n" +
      "Pilih aksi yang ingin dilakukan:",
    { parse_mode: "Markdown", reply_markup: sewaJasaDashboard() }
  );
  await ctx.answerCallbackQuery();
});

// ─── Callback: scan grup ─────────────────────────────────────────────────────
composer.callbackQuery("sj:scan_groups", async (ctx) => {
  const userId = ctx.from.id;

  if (!(await hasSession(userId))) {
    await ctx.answerCallbackQuery("⚠️ Akun belum terhubung.");
    return;
  }

  await ctx.editMessageText(
    "⏳ *Sedang memindai grup...*\n\nMohon tunggu sebentar.",
    { parse_mode: "Markdown" }
  );
  await ctx.answerCallbackQuery();

  const groups = await scanGroups(userId);

  if (!groups) {
    await ctx.editMessageText(
      "❌ Gagal memindai grup. Session mungkin sudah tidak valid.\n\n" +
        "Coba logout dan login ulang.",
      { reply_markup: sewaJasaDashboard() }
    );
    return;
  }

  if (groups.length === 0) {
    await ctx.editMessageText(
      "📭 *Tidak ada grup ditemukan.*\n\nAkun Anda tidak tergabung dalam grup manapun.",
      { parse_mode: "Markdown", reply_markup: afterScanMenu() }
    );
    return;
  }

  const typeIcon = (t: GroupInfo["type"]) =>
    t === "group" ? "👥" : t === "supergroup" ? "🏘️" : "📢";

  const display = groups.slice(0, 50);
  const lines = display.map(
    (g, i) =>
      `${i + 1}. ${typeIcon(g.type)} ${escapeMarkdown(g.title)}` +
      (g.memberCount ? ` _(${g.memberCount.toLocaleString("id-ID")} anggota)_` : "") +
      `\n   ID: \`${g.id}\``
  );

  const fullText =
    `📡 *Hasil Scan Grup*\n` +
    `Ditemukan *${groups.length}* grup/channel\n\n` +
    lines.join("\n") +
    (groups.length > 50 ? `\n\n_...dan ${groups.length - 50} lainnya_` : "");

  if (fullText.length > 4000) {
    // Kirim sebagai file
    const content = groups
      .map(
        (g, i) =>
          `${i + 1}. [${g.type.toUpperCase()}] ${g.title}` +
          (g.memberCount ? ` - ${g.memberCount} anggota` : "") +
          ` (ID: ${g.id})`
      )
      .join("\n");

    const { InputFile } = await import("grammy");
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(content, "utf-8"), "daftar_grup.txt"),
      {
        caption: `📡 *Hasil Scan Grup*\nTotal: ${groups.length} grup/channel`,
        parse_mode: "Markdown",
        reply_markup: afterScanMenu(),
      }
    );
    await ctx.deleteMessage().catch(() => {});
  } else {
    await ctx.editMessageText(fullText, {
      parse_mode: "Markdown",
      reply_markup: afterScanMenu(),
    });
  }
});

// ─── Callback: logout ─────────────────────────────────────────────────────────
composer.callbackQuery("sj:logout", async (ctx) => {
  const userId = ctx.from.id;
  await deleteSession(userId);
  clearLoginState(userId);

  await ctx.editMessageText(
    "🔌 *Logout Berhasil*\n\n" +
      "Akun Telegram Anda telah diputus.\n\n" +
      "Gunakan /login untuk menghubungkan akun lagi.",
    { parse_mode: "Markdown" }
  );
  await ctx.answerCallbackQuery("Logout berhasil.");
});

// ─── Callback: status layanan ─────────────────────────────────────────────────
composer.callbackQuery("sj:status", async (ctx) => {
  const userId = ctx.from.id;
  const subs = await getActiveSubscriptions(userId);
  const sewaSub = subs.find((s) => s.serviceType === "sewa_jasa");

  if (!sewaSub) {
    await ctx.answerCallbackQuery("Tidak ada layanan aktif.");
    return;
  }

  const { formatRemaining } = await import("../../../services/subscription");
  const expiry = sewaSub.expiresAt.toLocaleString("id-ID", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const sessionStatus = (await hasSession(userId)) ? "✅ Terhubung" : "❌ Belum login";

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📊 *Status Sewa Jasa*\n\n` +
      `Kode: \`${sewaSub.code}\`\n` +
      `Durasi: ${sewaSub.durationDays} hari\n` +
      `Aktif sampai: ${expiry}\n` +
      `Sisa: ${formatRemaining(sewaSub.expiresAt)}\n` +
      `Akun: ${sessionStatus}`,
    { parse_mode: "Markdown", reply_markup: sewaJasaDashboard() }
  );
});

// ─── Command /login ───────────────────────────────────────────────────────────
composer.command("login", async (ctx) => {
  const userId = ctx.from!.id;

  if (!isApiConfigured()) {
    await ctx.reply(
      "⚠️ *Fitur Sewa Jasa belum dikonfigurasi*\n\n" +
        "Admin perlu mengisi `API_ID` dan `API_HASH` di file `.env`.\n" +
        "Ambil dari: https://my.telegram.org/apps",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Cek subscription aktif
  const { getActiveSubscriptions } = await import("../../../services/subscription");
  const activeSubs = await getActiveSubscriptions(userId);
  const hasSewaJasa = activeSubs.some((s) => s.serviceType === "sewa_jasa");

  if (activeSubs.length === 0) {
    await ctx.reply(
      "❌ *Akses Ditolak*\n\n" +
        "Anda tidak memiliki sesi aktif.\n\n" +
        "Gunakan `/redeem <KODE>` untuk mengaktifkan layanan terlebih dahulu.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!hasSewaJasa) {
    await ctx.reply(
      "❌ *Akses Ditolak*\n\n" +
        "Fitur login hanya tersedia untuk layanan *Sewa Jasa*.\n\n" +
        "Pilih layanan Sewa Jasa terlebih dahulu melalui menu redeem.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (await hasSession(userId)) {
    await ctx.reply(
      "✅ Akun Anda sudah terhubung.\n\nGunakan tombol di bawah:",
      { reply_markup: sewaJasaDashboard() }
    );
    return;
  }

  await ctx.reply(
    "🔑 *Login Akun Telegram*\n\n" +
      "⚠️ *PENTING DEMI KEAMANAN AKUN:*\n" +
      "Pastikan akun Anda *SUDAH MENGAKTIFKAN 2FA (Verifikasi 2 Langkah)* di aplikasi resmi Telegram sebelum login agar akun aman dari pembatasan/limit otomatis.\n\n" +
      "Tap tombol di bawah untuk membagikan nomor HP Anda.",
    { parse_mode: "Markdown", reply_markup: requestContactKeyboard() }
  );
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[\]()~>#+=|{}.!\\-]/g, "\\$&");
}

// Encode/decode nomor HP untuk callback data (hapus karakter non-alfanumerik)
function encodePhone(phone: string): string {
  return phone.replace(/\+/g, "p").replace(/[^0-9p]/g, "");
}

// Versi exported untuk dipakai modul lain (control.ts)
export function encodePhoneForCallback(phone: string): string {
  return encodePhone(phone);
}

function decodePhone(encoded: string): string {
  return "+" + encoded.replace(/^p/, "");
}

export default composer;
