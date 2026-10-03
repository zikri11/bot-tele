import {
  loadClientByAccount,
  getAccountBroadcastState,
  setAccountBroadcastRunning,
  stopAccountBroadcastState,
  incrementAccountBroadcastRound,
  getAccountGrantees,
} from "./gramjs";
import { getUserSettings, calculateDelay, getNotifySettings, setNotifyEnabled } from "./userSettings";
import { getActiveSubscriptions } from "./subscription";
import { getGroupListItems } from "./groupList";
import { Bot, InputFile, InlineKeyboard } from "grammy";

// ─── Tipe ─────────────────────────────────────────────────────────────────────

export interface FailedGroup {
  title: string;
  reason: string;
}

export interface BroadcastTarget {
  chatId: string;
  title: string;
  type: "group" | "supergroup" | "channel";
}

export interface BroadcastProgress {
  accountId: number;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  isRunning: boolean;
  isDone: boolean;
  failedGroups: FailedGroup[];
  startedAt: Date;
  finishedAt?: Date;
  round: number;
  isLooping: boolean;
}

// ─── State in-memory per AKUN (bukan per user) ───────────────────────────────
const broadcastStates = new Map<number, BroadcastProgress>(); // key: accountId
const stopFlags = new Map<number, boolean>();                  // key: accountId

export function getBroadcastStateByAccount(accountId: number): BroadcastProgress | null {
  return broadcastStates.get(accountId) ?? null;
}

export function isBroadcastingByAccount(accountId: number): boolean {
  return broadcastStates.get(accountId)?.isRunning ?? false;
}

export function stopBroadcastByAccount(accountId: number) {
  stopFlags.set(accountId, true);
  const state = broadcastStates.get(accountId);
  if (state) state.isRunning = false;
}

// ─── Cek langganan masih aktif ────────────────────────────────────────────────
async function isSubscriptionActive(userId: number): Promise<boolean> {
  const subs = await getActiveSubscriptions(userId);
  return subs.length > 0;
}

// ─── Kirim 1 putaran ke semua grup ───────────────────────────────────────────
async function runOneBroadcastRound(
  userId: number,
  accountId: number,
  message: string,
  targets: BroadcastTarget[],
  progress: BroadcastProgress,
  onProgress: (p: BroadcastProgress) => Promise<void>
): Promise<void> {
  const delaySettings = await getUserSettings(userId);
  if (!delaySettings) return;

  const client = await loadClientByAccount(accountId);
  if (!client) {
    progress.failed += targets.length;
    return;
  }

  // Reset counter per putaran
  progress.sent = 0;
  progress.failed = 0;
  progress.skipped = 0;
  progress.failedGroups = [];
  progress.startedAt = new Date();

  let lastProgressUpdate = Date.now();

  for (const target of targets) {
    if (stopFlags.get(accountId)) {
      progress.skipped = targets.length - progress.sent - progress.failed;
      break;
    }

    try {
      const sendTarget = formatChatIdForSend(target.chatId, target.type);
      await client.sendMessage(sendTarget, { message });
      progress.sent++;
    } catch (err: any) {
      const errMsg: string = err?.message || String(err);
      const reason = parseErrorReason(errMsg);
      progress.failed++;
      progress.failedGroups.push({ title: target.title, reason });
      const errCode = errMsg.match(/([A-Z_]{5,})/)?.[1] || "UNKNOWN";
      console.warn(`[broadcast:${accountId}] ✗ ${target.title} → ${errCode}`);

      if (errMsg.includes("AUTH_KEY_UNREGISTERED")) {
        console.warn(`[broadcast:${accountId}] Sesi dicabut selama pengiriman. Membersihkan sesi.`);
        const { handleSessionRevoked } = await import("./gramjs");
        const { bot: mainBot } = await import("../bot/index");
        await handleSessionRevoked(accountId, mainBot);
        throw new Error("AUTH_KEY_UNREGISTERED");
      }

      if (errMsg.includes("FLOOD_WAIT")) {
        const seconds = parseInt(errMsg.match(/FLOOD_WAIT_(\d+)/)?.[1] || "30");
        await onProgress({ ...progress });
        lastProgressUpdate = Date.now();
        await delay((seconds + 2) * 1000);
        continue;
      }
    }

    if (Date.now() - lastProgressUpdate >= 3500) {
      await onProgress({ ...progress });
      lastProgressUpdate = Date.now();
    }

    if (!stopFlags.get(accountId) && delaySettings.mode === "per_group") {
      const baseDelay = calculateDelay(delaySettings);
      const jitter = Math.floor(Math.random() * 2000) - 1000;
      const actualDelay = Math.max(2000, baseDelay + jitter);
      await delay(actualDelay);
    }
  }

  progress.finishedAt = new Date();
  await client.disconnect().catch(() => {});
}

// ─── Broadcast utama — loop 24 jam, per akun ─────────────────────────────────
export async function startBroadcastForAccount(
  userId: number,
  accountId: number,
  message: string,
  targets: BroadcastTarget[],
  listName: string,
  listId: number,
  bot: Bot,
  onProgress: (progress: BroadcastProgress) => Promise<void>
): Promise<void> {
  if (isBroadcastingByAccount(accountId)) return;

  const delaySettings = await getUserSettings(userId);
  if (!delaySettings) return;

  const roundDelayMinutes =
    delaySettings.mode === "per_round"
      ? Math.round((delaySettings.seconds ?? 600) / 60)
      : 10;

  // Simpan state ke DB (per akun)
  await setAccountBroadcastRunning(accountId, listId, message, roundDelayMinutes);

  stopFlags.set(accountId, false);

  const progress: BroadcastProgress = {
    accountId,
    total: targets.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    isRunning: true,
    isDone: false,
    failedGroups: [],
    startedAt: new Date(),
    round: 1,
    isLooping: true,
  };
  broadcastStates.set(accountId, progress);

  // ─── Loop utama ───────────────────────────────────────────────────────────
  while (true) {
    if (stopFlags.get(accountId)) break;
    if (!(await isSubscriptionActive(userId))) {
      console.log(`[broadcast:${accountId}] Langganan habis, stop.`);
      break;
    }

    const dbState = await getAccountBroadcastState(accountId);
    if (!dbState.running) {
      console.log(`[broadcast:${accountId}] Sesi broadcast tidak berjalan atau dihapus, stop loop.`);
      break;
    }
    progress.round = dbState.round;
    progress.isRunning = true;
    progress.isDone = false;

    await onProgress({ ...progress });

    // Jalankan 1 putaran
    try {
      await runOneBroadcastRound(userId, accountId, message, targets, progress, onProgress);
    } catch (err: any) {
      if (err?.message === "AUTH_KEY_UNREGISTERED") {
        console.warn(`[broadcast:${accountId}] Sesi dicabut selama broadcast. Menghentikan loop.`);
        break;
      }
      console.error(`[broadcast:${accountId}] Error tak terduga pada putaran:`, err);
      break;
    }

    // Kirim notifikasi setelah putaran selesai
    await sendRoundNotification(userId, accountId, listName, progress, bot, message);

    if (stopFlags.get(accountId)) break;
    if (!(await isSubscriptionActive(userId))) break;

    // Increment round di DB
    await incrementAccountBroadcastRound(accountId);
    progress.round++;

    // Jeda antar putaran
    if (delaySettings.mode === "per_round") {
      const waitMs = calculateDelay(delaySettings);
      progress.isRunning = false;
      await onProgress({ ...progress });

      const checkInterval = 30_000;
      let waited = 0;
      while (waited < waitMs) {
        if (stopFlags.get(accountId)) break;
        if (!(await isSubscriptionActive(userId))) break;
        await delay(Math.min(checkInterval, waitMs - waited));
        waited += checkInterval;
      }

      if (stopFlags.get(accountId)) break;
      if (!(await isSubscriptionActive(userId))) break;
      progress.isRunning = true;
    }
  }

  // ─── Selesai ──────────────────────────────────────────────────────────────
  progress.isRunning = false;
  progress.isDone = true;
  progress.finishedAt = new Date();
  broadcastStates.set(accountId, progress);

  await stopAccountBroadcastState(accountId);
  stopFlags.delete(accountId);

  await onProgress({ ...progress });
}

// ─── Resume broadcast setelah bot restart ────────────────────────────────────
export async function resumeBroadcastForAccount(
  userId: number,
  accountId: number,
  bot: Bot,
  onProgress: (progress: BroadcastProgress) => Promise<void>
): Promise<void> {
  const state = await getAccountBroadcastState(accountId);
  if (!state.running || !state.listId || !state.message) return;

  const result = await getGroupListItems(state.listId, userId);
  if (!result || result.items.length === 0) {
    await stopAccountBroadcastState(accountId);
    return;
  }

  const targets = result.items.map((i) => ({
    chatId: i.chatId,
    title: i.title,
    type: i.type as "group" | "supergroup" | "channel",
  }));

  console.log(`[broadcast:${accountId}] Resuming, round ${state.round}`);

  await startBroadcastForAccount(
    userId, accountId, state.message, targets,
    result.list.name, state.listId, bot, onProgress
  );
}

// ─── Notifikasi setelah 1 putaran ─────────────────────────────────────────────
async function sendRoundNotification(
  userId: number,
  accountId: number,
  listName: string,
  progress: BroadcastProgress,
  bot: Bot,
  message: string
): Promise<void> {
  const notify = await getNotifySettings(userId);
  if (!notify.enabled || notify.targets.length === 0) return;

  const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  
  let summary =
    `<b>Berhasil Menyebar list!</b>\n\n` +
    `<blockquote>${escapeHtml(message)}</blockquote>\n\n` +
    `Sukses: ${progress.sent} Grup\n` +
    `Gagal: ${progress.failed} Grup\n`;

  if (progress.failedGroups.length > 0) {
    const failLines = progress.failedGroups
      .map(f => `> ${escapeHtml(f.reason)} dari ${escapeHtml(f.title)}`)
      .join("\n");
    summary += `\nGagal Terkirim:\n${failLines}\n`;
  }
  
  const botUsername = bot.botInfo?.username || "CVunBOT";
  summary += `\nLaporan oleh @${botUsername}`;

  // 1. Send via Admin target using Userbot (sent to grantees of this account)
  if (notify.targets.includes("admin")) {
    const grantees = await getAccountGrantees(accountId);
    if (grantees.length > 0) {
      const client = await loadClientByAccount(accountId);
      if (client) {
        try {
          for (const adminId of grantees) {
            try {
              // Resolusi entitas: coba dapatkan akses hash admin via username dulu
              let resolvedEntity: any = adminId;
              try {
                // Gunakan Bot Utama untuk cek apakah admin punya username
                const chatInfo = await bot.api.getChat(adminId);
                const username = (chatInfo as any).username;
                if (username) {
                  console.log(`[notify:admin] Resolving entity via username @${username}`);
                  resolvedEntity = await client.getEntity(username);
                } else {
                  // Tidak ada username, muat dialogs untuk isi cache
                  console.log(`[notify:admin] No username, loading dialogs to resolve entity ${adminId}...`);
                  await client.getDialogs({ limit: 100 });
                  // Coba resolve langsung setelah load dialogs
                  resolvedEntity = adminId;
                }
              } catch (_resolveErr) {
                // Resolusi gagal, gunakan ID langsung (mungkin berhasil jika ada di cache)
                resolvedEntity = adminId;
              }

              await client.sendMessage(resolvedEntity, { message: summary, parseMode: "html" });
              console.log(`[notify:admin] ✅ Berhasil kirim notifikasi ke admin ${adminId}`);

              if (progress.failedGroups.length > 30) {
                const content = progress.failedGroups
                  .map((f, i) => `${i + 1}. ${f.title}\n   Alasan: ${f.reason}`)
                  .join("\n\n");
                await client.sendFile(resolvedEntity, {
                  file: Buffer.from(content, "utf-8"),
                  workers: 1,
                  forceDocument: true,
                  caption: `❌ Detail kegagalan putaran ${progress.round}`,
                });
              }
            } catch (err: any) {
              const errMsg = String(err?.message || err);
              if (errMsg.includes("Could not find the input entity")) {
                console.warn(`[notify:admin] ⚠️ Admin ${adminId} tidak ditemukan di cache Userbot. Minta admin tersebut mengirim pesan ke nomor Userbot anda terlebih dahulu.`);
              } else {
                console.error(`[notify:admin] Gagal kirim ke remote admin ${adminId}:`, err);
              }
            }
          }
        } catch (err) {
          console.error(`[notify:admin] Gagal mengirim notif admin:`, err);
        } finally {
          await client.disconnect().catch(() => {});
        }
      }
    }
  }

  // 2. Send via Self target using Notify Bot (or fallback to main bot)
  if (notify.targets.includes("self")) {
    const { notifyBot } = await import("../bot/index");
    const senderBot = notifyBot || bot;
    const muteKeyboard = new InlineKeyboard().text('🔕 Matikan Notifikasi', 'ntf:quick_mute');

    try {
      await senderBot.api.sendMessage(userId, summary, {
        parse_mode: "HTML",
        reply_markup: muteKeyboard,
      });

      if (progress.failedGroups.length > 30) {
        const content = progress.failedGroups
          .map((f, i) => `${i + 1}. ${f.title}\n   Alasan: ${f.reason}`)
          .join("\n\n");
        await senderBot.api.sendDocument(
          userId,
          new InputFile(Buffer.from(content, "utf-8"), `detail_putaran_${progress.round}.txt`),
          { caption: `❌ Detail kegagalan putaran ${progress.round}` }
        );
      }
    } catch (err: any) {
      const errMsg = String(err?.message || err).toLowerCase();
      if (
        errMsg.includes("bot was blocked by the user") ||
        errMsg.includes("user is deactivated") ||
        errMsg.includes("chat not found")
      ) {
        console.warn(`[notify:self] User ${userId} telah memblokir bot atau akun tidak aktif. Menonaktifkan notifikasi otomatis.`);
        await setNotifyEnabled(userId, false);
        return;
      }
      console.error(`[notify:self] Gagal kirim ke user ${userId}:`, err);
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes} menit ${seconds} detik`;
  return `${seconds} detik`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

function parseErrorReason(msg: string): string {
  if (msg.includes("CHAT_WRITE_FORBIDDEN"))   return "Tidak punya izin kirim pesan";
  if (msg.includes("USER_BANNED_IN_CHANNEL")) return "Akun di-ban dari grup ini";
  if (msg.includes("CHANNEL_PRIVATE"))        return "Grup sudah menjadi private";
  if (msg.includes("PEER_ID_INVALID"))        return "ID grup tidak valid";
  if (msg.includes("INPUT_USER_DEACTIVATED")) return "Akun target tidak aktif";
  if (msg.includes("CHAT_RESTRICTED"))        return "Grup dibatasi";
  if (msg.includes("CHAT_ADMIN_REQUIRED"))    return "Hanya admin yang bisa kirim";
  if (msg.includes("FLOOD_WAIT")) {
    const sec = msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || "?";
    return `Rate limit Telegram (tunggu ${sec} detik)`;
  }
  const match = msg.match(/([A-Z_]{5,})/);
  return match ? match[1] : "Gagal mengirim";
}

function formatChatIdForSend(chatId: string, type: "group" | "supergroup" | "channel"): any {
  const idStr = chatId.replace(/^-/, "").replace(/^100/, "");
  if (type === "supergroup" || type === "channel") return Number(`-100${idStr}`);
  return Number(`-${idStr}`);
}
