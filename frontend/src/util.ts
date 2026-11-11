import type { ChatMessage, JobStatus } from "./types";

export const ACTIVE: JobStatus[] = ["queued", "fetching", "running", "saving"];
export const isActive = (s: JobStatus) => ACTIVE.includes(s);

export const STAT_LABELS: [string, string][] = [
  ["total", "Messages"], ["superchat", "Super Chats"], ["supersticker", "Super Stickers"],
  ["membership", "Memberships"], ["gifts", "Gifted members"], ["authors", "Unique chatters"],
];

export const TYPES: [string, string][] = [
  ["text_message", "Text"], ["superchat", "Super Chat"], ["supersticker", "Super Sticker"],
  ["membership", "Membership"], ["gift_purchase", "Gift purchase"], ["gift_redemption", "Gift redemption"],
  ["system", "System"],
];
export const ROLES: [string, string][] = [
  ["owner", "Owner"], ["moderator", "Moderator"], ["member", "Member"], ["verified", "Verified"],
];
export const COLUMNS: [string, string, boolean][] = [
  ["time", "Time", true], ["type", "Type", true], ["author", "Author", true],
  ["message", "Message", false], ["amount", "Amount", true],
];
export const PAGE = 100;
export const TIME_RE = /^\d+(:\d+){0,2}$/;

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fmtSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/** Same rules as app._parse_offset. */
export function parseTime(v: string): number | null {
  return TIME_RE.test(v) ? v.split(":").reduce((s, p) => s * 60 + Number(p), 0) * 1000 : null;
}

export function niceStep(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= v)!;
}

export const fmtMoney = (amt: number) => amt.toLocaleString(undefined, { maximumFractionDigits: 2 });

// Same rules as scraper.extract_video_id.
const VIDEO_ID_RE = /(?:v=|\/live\/|youtu\.be\/|\/shorts\/|\/embed\/|\/v\/)([A-Za-z0-9_-]{11})/;
export function videoIdOf(url: string): string | null {
  url = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  const m = url.match(VIDEO_ID_RE);
  return m ? m[1] : null;
}

export function roleClass(m: ChatMessage): string {
  return m.is_owner ? "owner" : m.is_moderator ? "mod" : m.is_member ? "member" : "";
}

export function messageText(m: ChatMessage): string {
  return [m.header_text, m.message, m.sticker_label ? `[sticker: ${m.sticker_label}]` : ""]
    .filter(Boolean).join(" — ");
}

export function typeLabel(t: string): string {
  const found = TYPES.find(([k]) => k === t);
  return found ? found[1] : t;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {  // clipboard API unavailable (e.g. page not served from localhost)
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
