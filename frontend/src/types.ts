// Shapes returned by the Flask API (app.py) and produced by scraper.parse_chat_item.

export type JobStatus = "queued" | "fetching" | "running" | "saving" | "done" | "cancelled" | "error";
export type ChatType = "all" | "top";
export type Format = "json" | "csv";

export interface JobSummary {
  id: string;
  url: string;
  video_id: string;
  chat_type: ChatType;
  title: string;
  status: JobStatus;
  total: number;
  resumable: boolean;
  offset_ms: number | null;
}

export interface Video {
  video_id: string;
  url: string;
  title: string;
  channel: string;
  channel_id: string;
  duration_seconds: number | null;
  thumbnail: string;
  chat_type: string;
}

export interface Stats {
  total_messages: number;
  by_type: Record<string, number>;
  unique_authors: number;
  paid_totals_by_currency: Record<string, number>;
  gifted_memberships: number;
}

export interface JobDetail {
  id: string;
  status: JobStatus;
  error: string | null;
  format: Format;
  video: Video | null;
  stats: Stats;
  progress: number | null;
  offset_ms: number;
  elapsed: number;
  recent: ChatMessage[];
  file: string | null;
}

export interface MessageRun {
  text?: string;
  emoji?: string;
  alt?: string;
}

export interface DisplayBadge {
  kind: "owner" | "moderator" | "member" | "verified";
  label: string;
  url: string;
}

export interface MessageDisplay {
  runs?: MessageRun[];
  badges?: DisplayBadge[];
  header_bg?: string;
  header_text?: string;
  body_bg?: string;
  body_text?: string;
  author_text?: string;
  header_primary?: string;
  header_sub?: string;
  gift_image?: string;
}

export interface ChatMessage {
  id: string;
  type: string;
  timestamp: string;
  timestamp_usec: number | null;
  time_in_video: string;
  video_offset_ms: number | null;
  author_name: string;
  author_channel_id: string;
  author_photo: string;
  author_badges: string[];
  is_owner: boolean;
  is_moderator: boolean;
  is_member: boolean;
  is_verified: boolean;
  message: string;
  amount_text: string;
  amount_value: number | null;
  currency: string;
  header_text: string;
  gift_count: number | null;
  sticker_label: string;
  sticker_url: string;
  color: string;
  display?: MessageDisplay;
}

export interface MessagesPage {
  total: number;
  offset: number;
  limit: number;
  focus: number | null;
  summary: Stats;
  currencies: string[];
  rows: ChatMessage[];
}

export interface Density {
  bucket_ms: number;
  window_ms: number;
  span_ms: number;
  counts: number[];
  nearby: number[];
  peaks: { offset_ms: number; count: number }[];
  total: number;
}
