import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { Logger } from "telegram/extensions";
import { config } from "../config";
import { db, schema } from "../db";
import { eq, and } from "drizzle-orm";

// ─── Logger kustom: suppress semua noise dari GramJS ─────────────────────────
// Pesan-pesan ini adalah internal GramJS yang tidak relevan untuk user/developer
const NOISE_PATTERNS = [
  "TIMEOUT",
  "connection closed",
  "Connecting to",
  "Connection to",
  "Using LAYER",
  "Disconnecting",
  "WebSocket connection failed",
  "connection retry",
  "MTProto",
  "Running gramJS",
];

class QuietLogger extends Logger {
  private isNoise(message: string): boolean {
    return NOISE_PATTERNS.some((p) => message.includes(p));
  }

  error(message: string): void {
    if (this.isNoise(message)) return;
    super.error(message);
  }

  warn(message: string): void {
    if (this.isNoise(message)) return;
    super.warn(message);
  }

  info(message: string): void {
    if (this.isNoise(message)) return;
    super.info(message);
  }

  debug(message: string): void {
    // Suppress semua debug — terlalu verbose
    return;
  }
}

// ─── State login per user (in-memory) ────────────────────────────────────────
export type LoginStep =
  | "idle"
  | "waiting_otp"
  | "waiting_password"
  | "done";

interface LoginState {
  step: LoginStep;
  phone?: string;
  phoneCodeHash?: string;
  client?: TelegramClient;
}

const loginStates = new Map<number, LoginState>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getState(userId: number): LoginState {
  if (!loginStates.has(userId)) {
    loginStates.set(userId, { step: "idle" });
  }
  return loginStates.get(userId)!;
}

export function getLoginStep(userId: number): LoginStep {
  return getState(userId).step;
}

export function getPhone(userId: number): string | undefined {
  return getState(userId).phone;
}

export function clearLoginState(userId: number) {
  const state = loginStates.get(userId);
  if (state?.client?.connected) {
    state.client.disconnect().catch(() => {});
  }
  loginStates.delete(userId);
}

// ─── Buat TelegramClient dengan koneksi yang lebih stabil ────────────────────
function createClient(existingSession = ""): TelegramClient {
  return new TelegramClient(
    new StringSession(existingSession),
    config.apiId,
    config.apiHash,
    {
      connectionRetries: 5,
      retryDelay: 1000,
      useWSS: true,
      timeout: 30,
      deviceModel: "Xiaomi 2201116SG",
      systemVersion: "SDK 33",
      appVersion: "10.14.5 (4890)",
      langCode: "id",
      systemLangCode: "id",
      baseLogger: new QuietLogger(),
    }
  );
}

// ─── Step 1: Kirim OTP ke nomor HP ───────────────────────────────────────────

export async function startLogin(
  userId: number,
  phone: string
): Promise<{ success: boolean; message: string }> {
  const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;

  // Bersihkan state lama kalau ada
  clearLoginState(userId);

  const client = createClient();

  try {
    await client.connect();

    await delay(1200 + Math.floor(Math.random() * 800));

    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: normalizedPhone,
        apiId: config.apiId,
        apiHash: config.apiHash,
        settings: new Api.CodeSettings({}),
      })
    );

    const phoneCodeHash = (result as any).phoneCodeHash as string;

    loginStates.set(userId, {
      step: "waiting_otp",
      phone: normalizedPhone,
      phoneCodeHash,
      client,
    });

    return { success: true, message: "OTP terkirim." };
  } catch (err: any) {
    await client.disconnect().catch(() => {});
    const msg: string = err?.message || "Gagal mengirim OTP.";

    if (msg.includes("PHONE_NUMBER_INVALID")) {
      return { success: false, message: "Nomor HP tidak valid." };
    }
    if (msg.includes("FLOOD_WAIT")) {
      const seconds = msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || "beberapa";
      return {
        success: false,
        message: `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.`,
      };
    }
    if (msg.includes("Not connected") || msg.includes("ECONNREFUSED") || msg.includes("timeout")) {
      return {
        success: false,
        message: "Gagal terhubung ke server Telegram. Periksa koneksi internet server dan coba lagi.",
      };
    }
    return { success: false, message: `Gagal: ${msg}` };
  }
}

// ─── Step 2: Submit OTP ───────────────────────────────────────────────────────

export type OtpResult =
  | { status: "success"; sessionString: string }
  | { status: "need_password" }
  | { status: "error"; message: string };

export async function submitOtp(
  userId: number,
  code: string
): Promise<OtpResult> {
  const state = getState(userId);
  if (
    state.step !== "waiting_otp" ||
    !state.client ||
    !state.phone ||
    !state.phoneCodeHash
  ) {
    return {
      status: "error",
      message: "Sesi login tidak ditemukan. Mulai ulang dengan /login.",
    };
  }

  try {
    await delay(1500 + Math.floor(Math.random() * 1000));

    await state.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: state.phone,
        phoneCodeHash: state.phoneCodeHash,
        phoneCode: code.trim(),
      })
    );

    const sessionString = (state.client.session as StringSession).save();
    // Disconnect — tidak perlu koneksi aktif setelah dapat session string
    await state.client.disconnect().catch(() => {});
    loginStates.set(userId, { ...state, step: "done", client: undefined });
    return { status: "success", sessionString };
  } catch (err: any) {
    const msg: string = err?.message || "";

    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      loginStates.set(userId, { ...state, step: "waiting_password" });
      return { status: "need_password" };
    }
    if (msg.includes("PHONE_CODE_INVALID")) {
      return { status: "error", message: "Kode OTP salah. Coba lagi." };
    }
    if (msg.includes("PHONE_CODE_EXPIRED")) {
      clearLoginState(userId);
      return {
        status: "error",
        message: "Kode OTP sudah kedaluwarsa. Mulai ulang dengan /login.",
      };
    }
    return { status: "error", message: `Gagal: ${msg}` };
  }
}

// ─── Step 3: Submit password 2FA ─────────────────────────────────────────────

export async function submitPassword(
  userId: number,
  password: string
): Promise<{ success: boolean; sessionString?: string; message: string }> {
  const state = getState(userId);
  if (state.step !== "waiting_password" || !state.client) {
    return {
      success: false,
      message: "Sesi login tidak ditemukan. Mulai ulang dengan /login.",
    };
  }

  try {
    await delay(1200 + Math.floor(Math.random() * 800));

    await state.client.signInWithPassword(
      { apiId: config.apiId, apiHash: config.apiHash },
      {
        password: async () => password,
        onError: async (err) => { throw err; },
      }
    );

    const sessionString = (state.client.session as StringSession).save();
    // Disconnect setelah dapat session string
    await state.client.disconnect().catch(() => {});
    loginStates.set(userId, { ...state, step: "done", client: undefined });
    return { success: true, sessionString, message: "Login berhasil." };
  } catch (err: any) {
    const msg: string = err?.message || "";
    if (msg.includes("PASSWORD_HASH_INVALID")) {
      return { success: false, message: "Password salah. Coba lagi." };
    }
    return { success: false, message: `Gagal: ${msg}` };
  }
}

// ─── Multi-Account Session Management ────────────────────────────────────────

export const MAX_ACCOUNTS = 10;

export interface AccountInfo {
  id: number;
  phone: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
}

/**
 * Tambah akun baru. Kalau ini akun pertama user, otomatis jadi aktif.
 */
export async function addAccount(
  userId: number,
  phone: string,
  sessionString: string
): Promise<number> {
  const existing = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.userId, userId));

  // Cek apakah nomor ini sudah ada → update saja
  const samePhone = existing.find((a) => a.phone === phone);
  if (samePhone) {
    await db
      .update(schema.userSessions)
      .set({ sessionString, lastUsedAt: new Date() })
      .where(eq(schema.userSessions.id, samePhone.id));
    return samePhone.id;
  }

  // Akun pertama otomatis aktif
  const isFirst = existing.length === 0;

  const inserted = await db
    .insert(schema.userSessions)
    .values({
      userId,
      phone,
      sessionString,
      label: phone,
      isActive: isFirst ? 1 : 0,
    })
    .returning();

  return inserted[0].id;
}

/**
 * Ambil semua akun milik user.
 */
export async function getAccounts(userId: number): Promise<AccountInfo[]> {
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.userId, userId))
    .orderBy(schema.userSessions.id);

  return rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    label: r.label ?? r.phone,
    isActive: (r.isActive ?? 0) === 1,
    createdAt: r.createdAt,
  }));
}

/**
 * Jumlah akun milik user.
 */
export async function countAccounts(userId: number): Promise<number> {
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.userId, userId));
  return rows.length;
}

/**
 * Ambil akun yang sedang aktif.
 */
export async function getActiveAccount(userId: number): Promise<AccountInfo | null> {
  // Cek akun remote aktif
  const remote = await db
    .select({
      id: schema.userSessions.id,
      phone: schema.userSessions.phone,
      label: schema.userSessions.label,
      createdAt: schema.userSessions.createdAt,
    })
    .from(schema.activeRemoteAccounts)
    .innerJoin(schema.userSessions, eq(schema.activeRemoteAccounts.accountId, schema.userSessions.id))
    .where(eq(schema.activeRemoteAccounts.userId, userId))
    .limit(1);

  if (remote.length > 0) {
    const r = remote[0];
    return {
      id: r.id,
      phone: r.phone,
      label: `[REMOTE] ${r.label ?? r.phone}`,
      isActive: true,
      createdAt: r.createdAt,
    };
  }

  // Cek akun lokal
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(
      and(
        eq(schema.userSessions.userId, userId),
        eq(schema.userSessions.isActive, 1)
      )
    )
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    phone: r.phone,
    label: r.label ?? r.phone,
    isActive: true,
    createdAt: r.createdAt,
  };
}

/**
 * Set akun aktif (matikan yang lain).
 */
export async function setActiveAccount(userId: number, accountId: number): Promise<boolean> {
  // Pastikan akun milik user ini
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(
      and(
        eq(schema.userSessions.id, accountId),
        eq(schema.userSessions.userId, userId)
      )
    )
    .limit(1);
  if (rows.length === 0) return false;

  // Matikan semua akun user, lalu aktifkan yang dipilih
  await db
    .update(schema.userSessions)
    .set({ isActive: 0 })
    .where(eq(schema.userSessions.userId, userId));

  await db
    .update(schema.userSessions)
    .set({ isActive: 1 })
    .where(eq(schema.userSessions.id, accountId));

  return true;
}

/**
 * Rename label akun.
 */
export async function renameAccount(
  userId: number,
  accountId: number,
  newLabel: string
): Promise<boolean> {
  const result = await db
    .update(schema.userSessions)
    .set({ label: newLabel })
    .where(
      and(
        eq(schema.userSessions.id, accountId),
        eq(schema.userSessions.userId, userId)
      )
    )
    .returning();
  return result.length > 0;
}

/**
 * Hapus satu akun. Kalau akun aktif yang dihapus, otomatis pilih akun lain.
 */
export async function deleteAccount(userId: number, accountId: number): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(
      and(
        eq(schema.userSessions.id, accountId),
        eq(schema.userSessions.userId, userId)
      )
    )
    .limit(1);
  if (rows.length === 0) return false;

  const wasActive = (rows[0].isActive ?? 0) === 1;

  // Hapus referensi remote access terlebih dahulu untuk menghindari constraint violation
  await db.delete(schema.activeRemoteAccounts).where(eq(schema.activeRemoteAccounts.accountId, accountId));
  await db.delete(schema.remoteAccessGrants).where(eq(schema.remoteAccessGrants.accountId, accountId));

  await db.delete(schema.userSessions).where(eq(schema.userSessions.id, accountId));

  // Kalau yang dihapus adalah akun aktif, set akun lain jadi aktif
  if (wasActive) {
    const remaining = await db
      .select()
      .from(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId))
      .orderBy(schema.userSessions.id)
      .limit(1);
    if (remaining.length > 0) {
      await db
        .update(schema.userSessions)
        .set({ isActive: 1 })
        .where(eq(schema.userSessions.id, remaining[0].id));
    }
  }

  return true;
}

/**
 * Menangani sesi Telegram yang kedaluwarsa atau dicabut secara paksa.
 * Menghentikan broadcast, menghapus referensi remote access, menghapus sesi dari DB,
 * dan mengirimkan notifikasi peringatan kepada pengguna.
 */
export async function handleSessionRevoked(accountId: number, bot: any): Promise<void> {
  // 1. Dapatkan info akun
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.id, accountId))
    .limit(1);
  const row = rows[0];
  if (!row) return;

  const { userId, phone } = row;
  console.warn(`[Session Revoked] Akun ID ${accountId} (${phone}) milik user ${userId} telah dicabut.`);

  // 2. Stop broadcast state di DB
  await stopAccountBroadcastState(accountId);

  // 3. Hapus relasi remote access yang terkait dengan akun ini
  await db.delete(schema.activeRemoteAccounts).where(eq(schema.activeRemoteAccounts.accountId, accountId));
  await db.delete(schema.remoteAccessGrants).where(eq(schema.remoteAccessGrants.accountId, accountId));

  // 4. Hapus sesi dari database
  await db.delete(schema.userSessions).where(eq(schema.userSessions.id, accountId));

  // 5. Kirim notifikasi ke pemilik akun via bot notifikasi (atau fallback bot utama)
  const message =
    `⚠️ *Koneksi Terputus!*\n\n` +
    `Sesi Telegram untuk akun *${phone}* telah kedaluwarsa atau dicabut (Session Revoked/Unregistered).\n\n` +
    `Semua broadcast aktif untuk akun ini telah *dihentikan* otomatis dan akun telah dihapus dari bot.\n` +
    `Silakan hubungkan kembali akun Anda menggunakan menu /login di Bot Utama.`;

  const { notifyBot } = await import("../bot/index");
  const senderBot = notifyBot || bot;
  try {
    await senderBot.api.sendMessage(userId, message, { parse_mode: "Markdown" });
  } catch (err: any) {
    const errMsg = String(err?.message || err).toLowerCase();
    if (errMsg.includes("bot was blocked") || errMsg.includes("user is deactivated")) {
      console.warn(`[Session Revoked] User ${userId} memblokir bot atau akun tidak aktif. Melewati fallback.`);
      return;
    }
    try {
      await bot.api.sendMessage(userId, message, { parse_mode: "Markdown" });
    } catch (err2) {
      console.error(`[Session Revoked] Gagal mengirim notifikasi ke user ${userId}:`, err2);
    }
  }
}

/**
 * Load client untuk akun tertentu (by accountId).
 */
export async function loadClientByAccount(accountId: number): Promise<TelegramClient | null> {
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.id, accountId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const client = createClient(row.sessionString);
  try {
    await client.connect();

    // Periksa apakah sesi terotorisasi/aktif
    let isAuth = false;
    try {
      isAuth = await client.isUserAuthorized();
    } catch (err: any) {
      if (err?.message?.includes("AUTH_KEY_UNREGISTERED")) {
        await client.disconnect().catch(() => {});
        const { bot } = await import("../bot/index");
        await handleSessionRevoked(accountId, bot);
        return null;
      }
      throw err;
    }

    if (!isAuth) {
      await client.disconnect().catch(() => {});
      const { bot } = await import("../bot/index");
      await handleSessionRevoked(accountId, bot);
      return null;
    }

    await db
      .update(schema.userSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.userSessions.id, accountId));
    return client;
  } catch (err: any) {
    await client.disconnect().catch(() => {});
    return null;
  }
}

// ─── Wrapper kompatibilitas (pakai akun AKTIF) ───────────────────────────────

/**
 * Simpan session — sekarang menambah akun baru (multi-account).
 */
export async function saveSession(
  userId: number,
  phone: string,
  sessionString: string
): Promise<void> {
  await addAccount(userId, phone, sessionString);
}

/**
 * Load client untuk akun AKTIF user.
 */
export async function loadClient(userId: number): Promise<TelegramClient | null> {
  const active = await getActiveAccount(userId);
  if (!active) return null;
  return loadClientByAccount(active.id);
}

/**
 * Cek apakah user punya minimal 1 akun.
 */
export async function hasSession(userId: number): Promise<boolean> {
  const c = await countAccounts(userId);
  if (c > 0) return true;

  // Cek apakah punya akun remote aktif
  const remote = await db
    .select()
    .from(schema.activeRemoteAccounts)
    .where(eq(schema.activeRemoteAccounts.userId, userId))
    .limit(1);
  
  return remote.length > 0;
}

/**
 * Hapus SEMUA akun user (dipakai saat endsub/logout total).
 */
export async function deleteSession(userId: number): Promise<void> {
  await db
    .delete(schema.userSessions)
    .where(eq(schema.userSessions.userId, userId));
}

// ─── Scan grup dari akun user ─────────────────────────────────────────────────

export interface GroupInfo {
  id: string;
  title: string;
  type: "group" | "supergroup" | "channel";
  memberCount?: number;
}

export async function scanGroups(userId: number): Promise<GroupInfo[] | null> {
  const client = await loadClient(userId);
  if (!client) return null;

  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    const groups: GroupInfo[] = [];

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!entity) continue;

      if (entity.className === "Chat") {
        const chat = entity as Api.Chat;
        groups.push({
          id: String(chat.id),
          title: chat.title || "Tanpa Nama",
          type: "group",
          memberCount: chat.participantsCount ?? undefined,
        });
      } else if (entity.className === "Channel") {
        const ch = entity as Api.Channel;
        if (ch.megagroup || ch.broadcast) {
          groups.push({
            id: String(ch.id),
            title: ch.title || "Tanpa Nama",
            type: ch.megagroup ? "supergroup" : "channel",
          });
        }
      }
    }

    return groups;
  } catch {
    return null;
  } finally {
    await client.disconnect();
  }
}

// ─── Broadcast state per akun ─────────────────────────────────────────────────

export interface AccountBroadcastState {
  running: boolean;
  listId: number | null;
  message: string | null;
  startedAt: Date | null;
  round: number;
  roundDelayMinutes: number | null;
}

export async function getAccountBroadcastState(accountId: number): Promise<AccountBroadcastState> {
  const rows = await db
    .select()
    .from(schema.userSessions)
    .where(eq(schema.userSessions.id, accountId))
    .limit(1);
  const r = rows[0];
  if (!r) return { running: false, listId: null, message: null, startedAt: null, round: 0, roundDelayMinutes: null };
  return {
    running: (r.broadcastRunning ?? 0) === 1,
    listId: r.broadcastListId ?? null,
    message: r.broadcastMessage ?? null,
    startedAt: r.broadcastStartedAt ?? null,
    round: r.broadcastRound ?? 0,
    roundDelayMinutes: r.broadcastRoundDelayMinutes ?? null,
  };
}

export async function setAccountBroadcastRunning(
  accountId: number,
  listId: number,
  message: string,
  roundDelayMinutes: number
): Promise<void> {
  await db.update(schema.userSessions).set({
    broadcastRunning: 1,
    broadcastListId: listId,
    broadcastMessage: message,
    broadcastStartedAt: new Date(),
    broadcastRound: 1,
    broadcastRoundDelayMinutes: roundDelayMinutes,
  }).where(eq(schema.userSessions.id, accountId));
}

export async function incrementAccountBroadcastRound(accountId: number): Promise<void> {
  const state = await getAccountBroadcastState(accountId);
  await db.update(schema.userSessions).set({
    broadcastRound: state.round + 1,
  }).where(eq(schema.userSessions.id, accountId));
}

export async function stopAccountBroadcastState(accountId: number): Promise<void> {
  await db.update(schema.userSessions).set({
    broadcastRunning: 0,
    broadcastListId: null,
    broadcastMessage: null,
    broadcastStartedAt: null,
    broadcastRound: 0,
    broadcastRoundDelayMinutes: null,
  }).where(eq(schema.userSessions.id, accountId));
}

/**
 * Ambil semua akun yang broadcast_running = 1 (untuk resume saat restart).
 * Return: array of { userId, accountId }
 */
export async function getAllRunningBroadcastAccounts(): Promise<{ userId: number; accountId: number }[]> {
  const rows = await db
    .select({ userId: schema.userSessions.userId, accountId: schema.userSessions.id })
    .from(schema.userSessions)
    .where(eq(schema.userSessions.broadcastRunning, 1));
  return rows.map((r) => ({ userId: r.userId, accountId: r.accountId }));
}

// ─── Remote Access Management ─────────────────────────────────────────────────

export async function grantRemoteAccess(ownerId: number, granteeId: number, accountId: number): Promise<boolean> {
  const existing = await db
    .select()
    .from(schema.remoteAccessGrants)
    .where(
      and(
        eq(schema.remoteAccessGrants.granteeId, granteeId),
        eq(schema.remoteAccessGrants.accountId, accountId)
      )
    )
    .limit(1);
  if (existing.length > 0) return true;

  await db.insert(schema.remoteAccessGrants).values({ ownerId, granteeId, accountId });
  return true;
}

export async function revokeRemoteAccess(ownerId: number, grantId: number): Promise<boolean> {
  const result = await db.delete(schema.remoteAccessGrants)
    .where(and(eq(schema.remoteAccessGrants.id, grantId), eq(schema.remoteAccessGrants.ownerId, ownerId)))
    .returning();
  
  if (result.length > 0) {
    await db.delete(schema.activeRemoteAccounts)
      .where(eq(schema.activeRemoteAccounts.accountId, result[0].accountId));
    return true;
  }
  return false;
}

export async function getGrantedAccounts(granteeId: number): Promise<any[]> {
  const rows = await db
    .select({
      grantId: schema.remoteAccessGrants.id,
      accountId: schema.userSessions.id,
      phone: schema.userSessions.phone,
      label: schema.userSessions.label,
      ownerId: schema.remoteAccessGrants.ownerId,
    })
    .from(schema.remoteAccessGrants)
    .innerJoin(schema.userSessions, eq(schema.remoteAccessGrants.accountId, schema.userSessions.id))
    .where(eq(schema.remoteAccessGrants.granteeId, granteeId));
  
  return rows;
}

export async function getGivenGrants(ownerId: number): Promise<any[]> {
  const rows = await db
    .select({
      grantId: schema.remoteAccessGrants.id,
      granteeId: schema.remoteAccessGrants.granteeId,
      accountId: schema.userSessions.id,
      label: schema.userSessions.label,
    })
    .from(schema.remoteAccessGrants)
    .innerJoin(schema.userSessions, eq(schema.remoteAccessGrants.accountId, schema.userSessions.id))
    .where(eq(schema.remoteAccessGrants.ownerId, ownerId));
  
  return rows;
}

export async function getAccountGrantees(accountId: number): Promise<number[]> {
  const rows = await db
    .select({
      granteeId: schema.remoteAccessGrants.granteeId,
    })
    .from(schema.remoteAccessGrants)
    .where(eq(schema.remoteAccessGrants.accountId, accountId));
  
  return rows.map((r) => r.granteeId);
}

export async function setActiveRemoteAccount(userId: number, accountId: number): Promise<void> {
  await db.delete(schema.activeRemoteAccounts).where(eq(schema.activeRemoteAccounts.userId, userId));
  await db.insert(schema.activeRemoteAccounts).values({ userId, accountId });
}

export async function clearActiveRemoteAccount(userId: number): Promise<void> {
  await db.delete(schema.activeRemoteAccounts).where(eq(schema.activeRemoteAccounts.userId, userId));
}
