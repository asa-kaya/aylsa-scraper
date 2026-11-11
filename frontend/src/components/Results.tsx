import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { Density, MessagesPage, Video } from "../types";
import { PAGE, ROLES, TIME_RE, TYPES, fmtMoney, fmtTime } from "../util";
import DensityGraph from "./DensityGraph";
import MessageModal from "./MessageModal";
import ResultsTable from "./ResultsTable";

export interface View {
  types: Set<string>;
  roles: Set<string>;
  q: string;
  currency: string;
  hideEmoji: boolean;
  tFrom: string;
  tTo: string;
  sort: string;
  order: "asc" | "desc";
  offset: number;
}

const initialView = (): View => ({
  types: new Set(), roles: new Set(), q: "", currency: "", hideEmoji: false, tFrom: "", tTo: "",
  sort: "time", order: "asc", offset: 0,
});

function filterParams(v: View) {
  const p = new URLSearchParams();
  if (v.types.size) p.set("types", [...v.types].join(","));
  if (v.roles.size) p.set("roles", [...v.roles].join(","));
  if (v.q) p.set("q", v.q);
  if (v.currency) p.set("currency", v.currency);
  if (v.hideEmoji) p.set("hide_emoji", "1");
  if (TIME_RE.test(v.tFrom)) p.set("from", v.tFrom);
  if (TIME_RE.test(v.tTo)) p.set("to", v.tTo);
  p.set("sort", v.sort);
  p.set("order", v.order);
  return p;
}

const isBad = (v: string) => v !== "" && !TIME_RE.test(v);

/** Results table, filters and hot-spot graph for a finished job. */
export default function Results({ jobId, video }: { jobId: string; video: Video | null }) {
  const [view, setView] = useState<View>(initialView);
  const viewRef = useRef(view);
  const [qInput, setQInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [page, setPage] = useState<MessagesPage | null>(null);
  const [density, setDensity] = useState<Density | null>(null);
  const [densLoading, setDensLoading] = useState(false);
  const [modalIndex, setModalIndex] = useState(-1);
  const loadSeq = useRef(0), densSeq = useRef(0);
  const qTimer = useRef<number>(undefined), tTimer = useRef<number>(undefined);

  function commit(next: View) {
    viewRef.current = next;
    setView(next);
  }

  async function loadResults(v: View, at?: number) {
    const seq = ++loadSeq.current;
    const p = filterParams(v);
    p.set("offset", String(v.offset));
    p.set("limit", String(PAGE));
    if (at != null) p.set("at", String(at));  // server picks the page and returns the row index as "focus"
    const d = await api.getMessages(jobId, p);
    if (!d || seq !== loadSeq.current) return;  // drop stale responses
    if (d.offset !== viewRef.current.offset) commit({ ...viewRef.current, offset: d.offset });  // a jump may have moved page
    setPage(d);
  }

  async function loadDensity(v: View) {
    const seq = ++densSeq.current;
    setDensLoading(true);  // keep the old render, dimmed, while refetching
    const d = await api.getDensity(jobId, filterParams(v));
    if (!d || seq !== densSeq.current) return;
    setDensity(d);
    setDensLoading(false);
  }

  // The hot-spot graph ignores the time range, so range edits only redraw its shading.
  function applyFilters(next: View, refetchDensity = true) {
    next = { ...next, offset: 0 };
    commit(next);
    loadResults(next);
    if (refetchDensity) loadDensity(next);
  }

  useEffect(() => {
    loadResults(viewRef.current);
    loadDensity(viewRef.current);
    return () => { clearTimeout(qTimer.current); clearTimeout(tTimer.current); };
  }, []);

  function toggle(set: Set<string>, key: string) {
    const s = new Set(set);
    if (s.has(key)) s.delete(key); else s.add(key);
    return s;
  }

  function readTimeRange(from: string, to: string) {
    applyFilters({ ...viewRef.current, tFrom: from.trim(), tTo: to.trim() }, false);
  }

  function onTimeInput(from: string, to: string) {
    setFromInput(from);
    setToInput(to);
    clearTimeout(tTimer.current);
    tTimer.current = window.setTimeout(() => readTimeRange(from, to), 300);
  }

  function reset() {
    clearTimeout(qTimer.current);
    clearTimeout(tTimer.current);
    setQInput(""); setFromInput(""); setToInput("");
    applyFilters(initialView());
  }

  function sortBy(key: string) {
    const v = viewRef.current;
    const next: View = v.sort === key
      ? { ...v, order: v.order === "asc" ? "desc" : "asc", offset: 0 }
      : { ...v, sort: key, order: key === "amount" ? "desc" : "asc", offset: 0 };
    commit(next);
    loadResults(next);
  }

  function goPage(offset: number) {
    const next = { ...viewRef.current, offset };
    commit(next);
    loadResults(next);
  }

  // Clear the time filter and page/scroll the table to the first message at `ms`.
  function jumpTo(ms: number) {
    clearTimeout(tTimer.current);
    setFromInput(""); setToInput("");
    let next: View = { ...viewRef.current, tFrom: "", tTo: "", offset: 0 };
    if (next.sort !== "time") next = { ...next, sort: "time", order: "asc" };
    commit(next);
    loadResults(next, Math.round(ms));
  }

  function setTimeRange(fromMs: number, toMs: number) {
    const from = fmtTime(fromMs), to = fmtTime(toMs);
    setFromInput(from); setToInput(to);
    clearTimeout(tTimer.current);
    readTimeRange(from, to);
  }

  const params = filterParams(view);
  const total = page?.total ?? 0;
  const s = page?.summary;
  const money = Object.entries(s?.paid_totals_by_currency || {});
  const from = total ? (page!.offset + 1) : 0, to = page ? Math.min(page.offset + page.rows.length, total) : 0;

  return (
    <section id="results" className="card">
      <label className="lbl">Results</label>
      <div className="filters">
        <div className="chips" id="type-chips">
          {TYPES.map(([t, label]) => (
            <button key={t} type="button" className={"chip" + (view.types.has(t) ? " on" : "")}
                    onClick={() => applyFilters({ ...viewRef.current, types: toggle(viewRef.current.types, t) })}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="chip preset" id="paid-only"
                onClick={() => applyFilters({ ...viewRef.current, types: new Set(["superchat", "supersticker"]),
                                              sort: "amount", order: "desc" })}>
          $ Paid only
        </button>
        <button type="button" className={"chip preset" + (view.hideEmoji ? " on" : "")} id="hide-emoji"
                title="Hide text messages made only of emoji / emotes"
                onClick={() => applyFilters({ ...viewRef.current, hideEmoji: !viewRef.current.hideEmoji })}>
          Hide emoji-only
        </button>
        <button type="button" className="chip preset" id="reset-filters" onClick={reset}>Reset</button>
      </div>
      <div className="filters">
        <input type="search" id="q" placeholder="Search author or message…" autoComplete="off" value={qInput}
               onChange={(e) => {
                 const val = e.target.value;
                 setQInput(val);
                 clearTimeout(qTimer.current);
                 qTimer.current = window.setTimeout(() => applyFilters({ ...viewRef.current, q: val.trim() }), 300);
               }} />
        <div className="roles" id="roles">
          {ROLES.map(([r, label]) => (
            <label key={r}>
              <input type="checkbox" value={r} checked={view.roles.has(r)}
                     onChange={() => applyFilters({ ...viewRef.current, roles: toggle(viewRef.current.roles, r) })} />
              {" " + label}
            </label>
          ))}
        </div>
        <select id="currency" value={view.currency}
                onChange={(e) => applyFilters({ ...viewRef.current, currency: e.target.value })}>
          <option value="">Any currency</option>
          {page?.currencies.map((c) => <option key={c}>{c}</option>)}
        </select>
        <div className="trange" title="Stream time, e.g. 1:05:22, 5:30 or 90">
          <input type="text" id="t-from" className={"time-in" + (isBad(view.tFrom) ? " bad" : "")} placeholder="From 0:00"
                 autoComplete="off" value={fromInput} onChange={(e) => onTimeInput(e.target.value, toInput)} /> –{" "}
          <input type="text" id="t-to" className={"time-in" + (isBad(view.tTo) ? " bad" : "")}
                 placeholder={video && video.duration_seconds ? "To " + fmtTime(video.duration_seconds * 1000) : "To"}
                 autoComplete="off" value={toInput} onChange={(e) => onTimeInput(fromInput, e.target.value)} />
        </div>
      </div>

      <DensityGraph density={density} loading={densLoading} tFrom={view.tFrom} tTo={view.tTo}
                    onJump={jumpTo} onRange={setTimeRange} />

      <div className="summary-line" id="summary-line">
        {page && s && <>
          <b>{total.toLocaleString()}</b>{` matching message${total === 1 ? "" : "s"}`}
          {money.length > 0 && <> · paid total <b>{money.map(([c, a]) => `${c}${fmtMoney(a)}`).join(" + ")}</b></>}
          {s.gifted_memberships ? ` · ${s.gifted_memberships.toLocaleString()} gifted memberships` : ""}
          {` · ${s.unique_authors.toLocaleString()} chatters`}
        </>}
      </div>

      <ResultsTable page={page} sort={view.sort} order={view.order}
                    onSort={sortBy} onOpen={setModalIndex} />

      <div className="pager">
        <button type="button" className="ghost" id="prev" disabled={!page || page.offset === 0}
                onClick={() => goPage(Math.max(0, viewRef.current.offset - PAGE))}>« Prev</button>
        <span id="page-info">{page ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : ""}</span>
        <button type="button" className="ghost" id="next" disabled={!page || page.offset + page.limit >= total}
                onClick={() => goPage(viewRef.current.offset + PAGE)}>Next »</button>
      </div>
      <div className="actions">
        <a className="btn ghost" id="dl-f-json" href={api.filteredDownloadUrl(jobId, params, "json")}>
          Download filtered JSON{page ? ` (${total.toLocaleString()})` : ""}
        </a>
        <a className="btn ghost" id="dl-f-csv" href={api.filteredDownloadUrl(jobId, params, "csv")}>
          Download filtered CSV{page ? ` (${total.toLocaleString()})` : ""}
        </a>
      </div>

      {page && modalIndex >= 0 && page.rows[modalIndex] && (
        <MessageModal rows={page.rows} index={modalIndex} position={page.offset + modalIndex + 1} total={total}
                      video={video} onIndex={setModalIndex} onClose={() => setModalIndex(-1)} />
      )}
    </section>
  );
}
