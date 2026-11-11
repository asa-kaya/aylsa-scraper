import type { ChatType, Density, Format, JobDetail, JobSummary, MessagesPage } from "./types";

async function json<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || fallback);
  return data as T;
}

export async function listJobs(): Promise<JobSummary[] | null> {
  try {
    const res = await fetch("/api/jobs");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function createJob(body: { url: string; format: Format; chat_type: ChatType }) {
  const res = await fetch("/api/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return json<{ id: string }>(res, "Failed to start");
}

export async function resumeJob(id: string) {
  return json<{ id: string }>(await fetch(`/api/jobs/${id}/resume`, { method: "POST" }), "Failed to resume");
}

export async function deleteJob(id: string) {
  await fetch(`/api/jobs/${id}`, { method: "DELETE" });
}

export async function cancelJob(id: string) {
  await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
}

export async function getJob(id: string): Promise<JobDetail> {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) throw new Error("Job not found (server restarted?)");
  return res.json();
}

/** Resolves null when the request fails (callers keep what they show). */
export async function getMessages(id: string, params: URLSearchParams): Promise<MessagesPage | null> {
  const res = await fetch(`/api/jobs/${id}/messages?${params}`);
  return res.ok ? res.json() : null;
}

export async function getDensity(id: string, params: URLSearchParams): Promise<Density | null> {
  const res = await fetch(`/api/jobs/${id}/density?${params}`);
  return res.ok ? res.json() : null;
}

export const downloadUrl = (id: string, format: Format) => `/api/jobs/${id}/download?format=${format}`;

export const filteredDownloadUrl = (id: string, params: URLSearchParams, format: Format) =>
  `/api/jobs/${id}/download?filtered=1&${params}&format=${format}`;
