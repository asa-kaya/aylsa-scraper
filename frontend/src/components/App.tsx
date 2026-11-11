import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { ChatType, Format, JobDetail, JobSummary, Video } from "../types";
import { isActive, videoIdOf } from "../util";
import JobPanel from "./JobPanel";
import LiveFeed from "./LiveFeed";
import Results from "./Results";
import ScrapeForm from "./ScrapeForm";

// One "run" per time a job is (re)started or loaded; resuming reuses the job id, so the
// run number is what restarts polling and resets the job/results panels.
interface Run { id: string; n: number }

export default function App() {
  const [url, setUrl] = useState("");
  const [chatType, setChatType] = useState<ChatType>("all");
  const [format, setFormat] = useState<Format>("json");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);  // disables "Start" while a job is starting/running

  const [jobList, setJobList] = useState<JobSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [results, setResults] = useState<{ id: string; video: Video | null; n: number } | null>(null);

  const runRef = useRef<Run | null>(null);
  runRef.current = run;
  const runCounter = useRef(0);
  const chipsTimer = useRef<number>(undefined);

  const clearCurrentJob = useCallback(() => {
    setRun(null);
    setJob(null);
    setResults(null);
    setBusy(false);
  }, []);

  const refreshJobs = useCallback(async () => {
    clearTimeout(chipsTimer.current);
    const list = await api.listJobs();
    if (!list) return;
    setJobList(list);
    // The job on screen was evicted or removed (maybe from another tab).
    const cur = runRef.current;
    if (cur && !list.some((j) => j.id === cur.id)) clearCurrentJob();
    if (list.some((j) => isActive(j.status))) chipsTimer.current = window.setTimeout(refreshJobs, 2000);
  }, [clearCurrentJob]);

  useEffect(() => {
    refreshJobs();
    return () => clearTimeout(chipsTimer.current);
  }, [refreshJobs]);

  function startJob(id: string) {
    setRun({ id, n: ++runCounter.current });
    setJob(null);
    setJobError(null);
    setResults(null);
  }

  // Poll the current job every second while it's active.
  useEffect(() => {
    if (!run) return;
    let stopped = false, timer: number | undefined;
    const tick = async () => {
      let j: JobDetail;
      try {
        j = await api.getJob(run.id);
      } catch (e) {
        if (stopped) return;
        setJobError((e as Error).message);
        setBusy(false);
        return;
      }
      if (stopped) return;
      setJob(j);
      if (isActive(j.status)) timer = window.setTimeout(tick, 1000);
      else setBusy(false);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [run]);

  // Show the results table once the job has finished and written its file.
  useEffect(() => {
    if (!run || !job || job.id !== run.id) return;
    const finished = job.status === "done" || job.status === "cancelled";
    if (finished && job.file && results?.n !== run.n) setResults({ id: job.id, video: job.video, n: run.n });
  }, [job, run, results]);

  // Stopped scrape in this session for the stream + chat type currently in the form.
  const vid = videoIdOf(url);
  const resumable = jobList.find((j) => j.resumable && j.video_id === vid && j.chat_type === chatType) || null;

  async function submit() {
    setFormError(null);
    if (resumable && !confirm(`Start over? The ${resumable.total.toLocaleString()} messages collected so far will be ` +
                              "discarded, and the saved partial file overwritten when the new scrape finishes.")) return;
    setBusy(true);
    try {
      const data = await api.createJob({ url: url.trim(), format, chat_type: chatType });
      startJob(data.id);
    } catch (e) {
      setFormError((e as Error).message);
      setBusy(false);
    }
    refreshJobs();
  }

  async function resume() {
    if (!resumable) return;
    setFormError(null);
    setBusy(true);
    try {
      const data = await api.resumeJob(resumable.id);
      startJob(data.id);
    } catch (e) {
      setFormError((e as Error).message);
      setBusy(false);
    }
    refreshJobs();
  }

  function loadJob(j: JobSummary) {
    if (!confirm(`Load "${j.title || j.video_id}"?\n${j.url}`)) return;
    setUrl(j.url);
    setChatType(j.chat_type === "top" ? "top" : "all");
    setFormError(null);
    startJob(j.id);
  }

  async function removeJob(j: JobSummary) {
    let msg = `Remove "${j.title || j.video_id}" from this session?\n\nIts chat data will be cleared from memory. ` +
              "Files already in downloads/ are kept.";
    if (isActive(j.status)) msg += "\n\nWarning: it is still scraping and will be stopped.";
    if (!confirm(msg)) return;
    await api.deleteJob(j.id);
    if (j.id === runRef.current?.id) clearCurrentJob();
    refreshJobs();
  }

  return (
    <main>
      <h1><span>&#9654;</span> AYLSA Scraper</h1>
      <p className="sub"><b>A YouTube Livestream Archive Scraper.</b> Grab the full live chat history of an archived livestream or premiere, including Super Chats, Super Stickers, memberships and gifted memberships.</p>

      <ScrapeForm
        url={url} onUrl={setUrl} chatType={chatType} onChatType={setChatType} format={format} onFormat={setFormat}
        error={formError} busy={busy} resumable={resumable} jobList={jobList} currentId={run?.id ?? null}
        onSubmit={submit} onResume={resume} onLoadJob={loadJob} onRemoveJob={removeJob}
      />

      {run && (
        <>
          <JobPanel key={`job-${run.n}`} job={job?.id === run.id ? job : null} error={jobError}
                    onCancel={() => api.cancelJob(run.id)} />
          {!results && <LiveFeed msgs={job?.id === run.id ? job.recent : []} />}
          {results && <Results key={`results-${results.n}`} jobId={results.id} video={results.video} />}
        </>
      )}
    </main>
  );
}
