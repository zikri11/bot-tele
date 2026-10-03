import { Composer, Context, InlineKeyboard } from "grammy";
import { hasSession, getActiveAccount } from "../../../services/gramjs";
import { getUserGroupLists, getGroupListItems } from "../../../services/groupList";
import {
  startBroadcastForAccount,
  stopBroadcastByAccount,
  getBroadcastStateByAccount,
  isBroadcastingByAccount,
  BroadcastProgress,
} from "../../../services/broadcast";
import { getActiveSubscriptions } from "../../../services/subscription";
import {
  getUserSettings,
  hasDelaySettings,
  formatDelaySettings,
} from "../../../services/userSettings";

async function getBot() {
  const { bot } = await import("../../index");
  return bot;
}

const composer = new Composer();

interface BroadcastFlowState {
  step: "waiting_message" | "waiting_list";
  message?: string;
  accountId?: number;  // akun yang dikunci saat mulai flow
  accountLabel?: string;
}
const broadcastFlows = new Map<number, BroadcastFlowState>();

// ─── Helper: cek akses ────────────────────────────────────────────────────────
async function canBroadcast(userId: number): Promise<{ ok: boolean; reason?: string; accountId?: number; accountLabel?: string }> {
  const subs = await getActiveSubscriptions(userId);
  if (subs.length === 0) return { ok: false, reason: "Anda tidak memiliki langganan aktif." };

  if (!(await hasSession(userId))) return { ok: false, reason: "Akun Telegram belum terhubung. Gunakan /login terlebih dahulu." };

  const active = await getActiveAccount(userId);
  if (!active) return { ok: false, reason: "Tidak ada akun aktif. Pilih akun di menu 🎛 Control." };

  return { ok: true, accountId: active.id, accountLabel: active.label };
}

// ─── Entry point ─────────────────────────────────────────────────────────────
export async function handleBroadcast(ctx: Context) {
  const userId = ctx.from!.id;

  const access = await canBroadcast(userId);
  if (!access.ok) {
    await ctx.reply(`❌ ${access.reason}`, { parse_mode: "Markdown" });
    return;
  }

  const { accountId, accountLabel } = access;

  // Cek apakah akun AKTIF ini sedang broadcast
  if (isBroadcastingByAccount(accountId!)) {
    const state = getBroadcastStateByAccount(accountId!)!;
    await ctx.reply(
      `⚠️ *Akun ${accountLabel} sedang broadcast!*\n\n` +
        `Putaran: ke-${state.round}\n` +
        `Progress: ${state.sent}/${state.total} terkirim`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🛑 Stop Broadcast", `bc:stop:${accountId}`),
      }
    );
    return;
  }

  if (!(await hasDelaySettings(userId))) {
    await ctx.reply(
      "⚠️ *Anda belum mengatur jeda broadcast!*\n\n" +
        "Tap tombol *⚙️ Atur Jeda* di keyboard untuk mengatur.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const lists = await getUserGroupLists(userId);
  if (lists.length === 0) {
    await ctx.reply(
      "⚠️ *Belum ada List Grup*\n\nBuat list grup terlebih dahulu.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Kunci akun aktif saat ini ke dalam flow
  broadcastFlows.set(userId, { step: "waiting_message", accountId: accountId!, accountLabel });

  await ctx.reply(
    `📣 *Broadcast Pesan*\n\n` +
      `Akun: *${accountLabel}*\n\n` +
      `Langkah 1/2: Kirim pesan yang ingin disebar.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("❌ Batal", "bc:cancel"),
    }
  );
}

// ─── Message handler ─────────────────────────────────────────────────────────
composer.on("message:text", async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return next();

  const flow = broadcastFlows.get(userId);
  if (!flow) return next();

  if (flow.step === "waiting_message") {
    if (text.length < 1) { await ctx.reply("⚠️ Pesan tidak boleh kosong."); return; }

    flow.message = text;
    flow.step = "waiting_list";
    broadcastFlows.set(userId, flow);

    const lists = await getUserGroupLists(userId);
    const keyboard = new InlineKeyboard();
    lists.forEach((l) => keyboard.text(`📋 ${l.name} (${l.itemCount} grup)`, `bc:list:${l.id}`).row());
    keyboard.text("❌ Batal", "bc:cancel");

    await ctx.reply(
      `✅ Pesan diterima.\n\n` +
        `Langkah 2/2: Pilih list grup tujuan:\n\n` +
        `_Preview:_\n━━━━━━━━━━━━━━━━━━━━\n` +
        `${text.length > 200 ? text.slice(0, 200) + "..." : text}\n━━━━━━━━━━━━━━━━━━━━`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    return;
  }

  return next();
});

// ─── Callback: pilih list ─────────────────────────────────────────────────────
composer.callbackQuery(/^bc:list:(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const listId = parseInt(ctx.match![1]);
  const flow = broadcastFlows.get(userId);

  if (!flow || !flow.message || !flow.accountId) {
    await ctx.editMessageText("⚠️ Sesi broadcast sudah habis. Coba lagi.");
    await ctx.answerCallbackQuery();
    return;
  }

  const result = await getGroupListItems(listId, userId);
  if (!result) { await ctx.answerCallbackQuery("List tidak ditemukan."); return; }

  const { list, items } = result;
  broadcastFlows.delete(userId);

  pendingBroadcast.set(userId, { message: flow.message, listId, accountId: flow.accountId, accountLabel: flow.accountLabel ?? "Akun" });

  const settings = (await getUserSettings(userId))!;
  const delayLabel = formatDelaySettings(settings);
  const avgDelaySec = settings.mode === "per_group" ? (settings.seconds ?? 10) : (settings.seconds ?? 600);
  const estMinutes = Math.ceil((items.length * avgDelaySec) / 60);

  const confirmMenu = new InlineKeyboard()
    .text("✅ Mulai Broadcast", `bc:start:${listId}`)
    .row()
    .text("❌ Batal", "bc:cancel");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `📣 *Konfirmasi Broadcast*\n\n` +
      `Akun: *${flow.accountLabel}*\n` +
      `List: *${list.name}*\n` +
      `Jumlah grup: *${items.length}*\n` +
      `Mode jeda: ${delayLabel}\n` +
      `Estimasi per putaran: ~${estMinutes} menit\n\n` +
      `⚠️ Broadcast akan berjalan 24 jam non-stop.\n` +
      `Lanjutkan?`,
    { parse_mode: "Markdown", reply_markup: confirmMenu }
  );
});

const pendingBroadcast = new Map<number, { message: string; listId: number; accountId: number; accountLabel: string }>();

// ─── Callback: mulai broadcast ────────────────────────────────────────────────
composer.callbackQuery(/^bc:start:(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const listId = parseInt(ctx.match![1]);
  const pending = pendingBroadcast.get(userId);

  if (!pending) { await ctx.editMessageText("⚠️ Sesi sudah habis."); await ctx.answerCallbackQuery(); return; }

  const result = await getGroupListItems(listId, userId);
  if (!result || result.items.length === 0) { await ctx.editMessageText("❌ List kosong."); await ctx.answerCallbackQuery(); return; }

  pendingBroadcast.delete(userId);

  const { list, items } = result;
  const { accountId, accountLabel } = pending;
  const targets = items.map((i) => ({ chatId: i.chatId, title: i.title, type: i.type as "group" | "supergroup" | "channel" }));

  await ctx.answerCallbackQuery("Broadcast dimulai!");

  const initialText = buildProgressText(list.name, accountLabel, { accountId, total: targets.length, sent: 0, failed: 0, skipped: 0, isRunning: true, isDone: false, failedGroups: [], startedAt: new Date(), round: 1, isLooping: true });
  const progressMsg = await ctx.editMessageText(
    initialText,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🛑 Stop", `bc:stop:${accountId}`) }
  );

  let lastEditTime = Date.now();
  let lastText = initialText;

  const botInstance = await getBot();
  startBroadcastForAccount(userId, accountId, pending.message, targets, list.name, listId, botInstance, async (progress) => {
    try {
      if (progress.isDone || !progress.isRunning || Date.now() - lastEditTime >= 3500) {
        const newText = buildProgressText(list.name, accountLabel, progress);
        if (newText !== lastText) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            (progressMsg as any).message_id,
            newText,
            {
              parse_mode: "Markdown",
              reply_markup: (progress.isDone || !progress.isRunning)
                ? undefined
                : new InlineKeyboard().text("🛑 Stop", `bc:stop:${accountId}`),
            }
          );
          lastEditTime = Date.now();
          lastText = newText;
        }
      }
    } catch { /* abaikan error edit */ }
  }).catch(async (err) => {
    await ctx.reply(`❌ Broadcast error: ${err?.message || "Unknown"}`);
  });
});

// ─── Callback: stop broadcast (per akun) ─────────────────────────────────────
composer.callbackQuery(/^bc:stop:(\d+)$/, async (ctx) => {
  const accountId = parseInt(ctx.match![1]);
  stopBroadcastByAccount(accountId);
  await ctx.answerCallbackQuery("Broadcast dihentikan.");
  await ctx.editMessageText("🛑 *Broadcast Dihentikan*", { parse_mode: "Markdown" });
});

// ─── Callback: batal ─────────────────────────────────────────────────────────
composer.callbackQuery("bc:cancel", async (ctx) => {
  const userId = ctx.from.id;
  broadcastFlows.delete(userId);
  pendingBroadcast.delete(userId);
  await ctx.editMessageText("❌ Broadcast dibatalkan.");
  await ctx.answerCallbackQuery("Dibatalkan.");
});

// ─── Helper: progress text ────────────────────────────────────────────────────
function buildProgressText(listName: string, accountLabel: string, p: BroadcastProgress): string {
  const done = p.sent + p.failed;
  const pct = p.total > 0 ? Math.round((done / p.total) * 100) : 0;
  const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  let status: string;
  if (p.isDone) status = p.skipped > 0 ? "🛑 Dihentikan" : "✅ Selesai";
  else if (!p.isRunning) status = "⏸ Menunggu putaran berikutnya...";
  else status = `⏳ Putaran ${p.round} berjalan...`;

  let text =
    `📣 *Broadcast — ${listName}*\n` +
    `Akun: *${accountLabel}*\n\n` +
    `Status: ${status}\n` +
    `Putaran: ke-${p.round}\n` +
    `\`${bar}\` ${pct}%\n\n` +
    `✅ Terkirim: ${p.sent}\n` +
    `❌ Gagal: ${p.failed}\n` +
    `⏭ Dilewati: ${p.skipped}\n` +
    `📊 Total: ${p.total}`;

  if ((p.isDone || !p.isRunning) && p.failedGroups.length > 0) {
    const preview = p.failedGroups.slice(0, 5).map((f) => `• ${f.title} — _${f.reason}_`).join("\n");
    const more = p.failedGroups.length > 5 ? `\n_...dan ${p.failedGroups.length - 5} lainnya_` : "";
    text += `\n\n━━━━━━━━━━━━━━━━━━━━\n❌ *Gagal di:*\n${preview}${more}`;
  }

  return text;
}

export default composer;
