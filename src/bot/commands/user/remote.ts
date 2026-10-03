import { Composer, InlineKeyboard } from "grammy";
import { getGrantedAccounts, setActiveRemoteAccount, clearActiveRemoteAccount } from "../../../services/gramjs";

const composer = new Composer();

export async function handleRemoteMenu(ctx: any) {
  const userId = ctx.from!.id;
  const accounts = await getGrantedAccounts(userId);
  
  if (accounts.length === 0) {
    await ctx.reply("⚠️ Anda belum diberikan akses remote ke akun manapun.");
    return;
  }
  
  const kb = new InlineKeyboard();
  accounts.forEach((a) => {
    kb.text(`🔌 Gunakan ${a.label}`, `rmt:use:${a.accountId}`).row();
  });
  kb.text("🔙 Kembali ke Akun Sendiri", "rmt:clear").row();
  
  await ctx.reply(`🕹 *Remote Akses*\n\nBerikut adalah daftar akun yang dibagikan kepada Anda. Pilih akun yang ingin dikontrol:`, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
}

composer.callbackQuery("rmt:menu", async (ctx) => {
  const userId = ctx.from.id;
  const accounts = await getGrantedAccounts(userId);
  await ctx.answerCallbackQuery();
  
  if (accounts.length === 0) {
    await ctx.editMessageText("⚠️ Anda belum diberikan akses remote ke akun manapun.");
    return;
  }
  
  const kb = new InlineKeyboard();
  accounts.forEach((a) => {
    kb.text(`🔌 Gunakan ${a.label}`, `rmt:use:${a.accountId}`).row();
  });
  kb.text("🔙 Kembali ke Akun Sendiri", "rmt:clear").row();
  
  await ctx.editMessageText(`🕹 *Remote Akses*\n\nBerikut adalah daftar akun yang dibagikan kepada Anda. Pilih akun yang ingin dikontrol:`, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

composer.callbackQuery(/^rmt:use:(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const accountId = parseInt(ctx.match![1]);
  
  // Verify again
  const accounts = await getGrantedAccounts(userId);
  const found = accounts.find(a => a.accountId === accountId);
  if (!found) {
    await ctx.answerCallbackQuery("Akses ke akun ini sudah tidak berlaku.");
    return;
  }
  
  await setActiveRemoteAccount(userId, accountId);
  await ctx.answerCallbackQuery("Berhasil beralih ke akun remote!");
  await ctx.editMessageText(`✅ Anda sekarang mengontrol akun remote: *${found.label}*\n\nSemua fitur (Scan, Broadcast, dll) akan menggunakan akun ini.`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("🔙 Kembali ke Menu Remote", "rmt:menu"),
  });

  const firstName = ctx.from?.first_name || "Pengguna";
  const { config } = await import("../../../config");

  const message = `👋🏻 Hai!, *${firstName}*\n` +
    `Selamat datang di *${config.botName}*\n\n` +
    `Asisten Pengelolaan & Pengiriman Pesan Terjadwal\n\n` +
    `Owner: ${config.botOwner}\n` +
    `Channel: ${config.botChannel}\n\n` +
    `✅Berhasil Remot Akun`;

  const keyboardRows = [
    [{ text: "📡 Scan Grup" }, { text: "📋 Buat List Grup" }],
    [{ text: "🗂 List Grup" }, { text: "📣 Broadcast" }],
    [{ text: "⚙️ Atur Jeda" }, { text: "🔔 Notifikasi" }],
    [{ text: "🚪 Bergabung Grup" }],
    [{ text: "📊 Status BC" }],
    [{ text: "🕹 Remote Akses" }]
  ];

  await ctx.reply(message, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: keyboardRows,
      resize_keyboard: true,
      is_persistent: true,
    },
  });
});

composer.callbackQuery("rmt:clear", async (ctx) => {
  const userId = ctx.from.id;
  await clearActiveRemoteAccount(userId);
  await ctx.answerCallbackQuery("Berhasil kembali ke akun sendiri.");
  await ctx.editMessageText(`✅ Anda telah berhenti mengontrol akun remote dan kembali ke sesi lokal Anda sendiri.`, {
    parse_mode: "Markdown",
  });
});

export default composer;
