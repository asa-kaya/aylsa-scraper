import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, MessagesPage } from "../types";
import { COLUMNS, copyText, messageText, roleClass, typeLabel } from "../util";

interface Props {
  page: MessagesPage | null;
  sort: string;
  order: "asc" | "desc";
  onSort: (key: string) => void;
  onOpen: (index: number) => void;
}

export default function ResultsTable({ page, sort, order, onSort, onOpen }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const [flash, setFlash] = useState<number | null>(null);

  // New page: scroll to top, or to the row a graph click jumped to (and flash it).
  useLayoutEffect(() => {
    const w = wrap.current;
    if (!w || !page) return;
    w.scrollTop = 0;
    if (page.focus == null || !page.rows[page.focus]) return;
    const row = body.current!.children[page.focus] as HTMLElement;
    w.scrollIntoView({ block: "nearest" });
    w.scrollTop = row.offsetTop - w.clientHeight / 3;
    setFlash(page.focus);
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [page]);

  return (
    <div className="table-wrap" id="table-wrap" ref={wrap}>
      <table>
        <thead>
          <tr id="thead-row">
            {page && COLUMNS.map(([key, label, sortable]) => (
              <th key={key} className={sortable ? "sortable" : ""} onClick={sortable ? () => onSort(key) : undefined}>
                {label + (sort === key ? (order === "asc" ? " ▲" : " ▼") : "")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody id="tbody" ref={body}>
          {page && (page.rows.length
            ? page.rows.map((m, i) => (
                <Row key={`${page.offset}-${i}`} m={m} focus={flash === i} onOpen={() => onOpen(i)} />
              ))
            : <tr><td className="empty" colSpan={COLUMNS.length}>No messages match these filters.</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ m, focus, onOpen }: { m: ChatMessage; focus: boolean; onOpen: () => void }) {
  const text = messageText(m);
  return (
    <tr className={focus ? "focus" : undefined}>
      <CopyCell className="time" text={m.time_in_video} what="time">{m.time_in_video}</CopyCell>
      <td className="pop" title="Show message" onClick={onOpen}>
        <span className={`pill ${m.type}`}>{typeLabel(m.type)}</span>
      </td>
      <CopyCell className="author" text={m.author_name} what="author">
        {m.author_photo && <img src={m.author_photo} alt="" loading="lazy" referrerPolicy="no-referrer" />}
        <span className={roleClass(m)}>{m.author_name}</span>
      </CopyCell>
      <CopyCell className="msgcell" text={text} what="message">{text}</CopyCell>
      <td className="amount" style={m.amount_text && m.color ? { background: m.color } : undefined}>{m.amount_text}</td>
    </tr>
  );
}

// Clicking the cell copies `text`, unless the click ended a drag-selection of text.
function CopyCell({ className, text, what, children }: {
  className: string; text: string; what: string; children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  if (!text) return <td className={className}>{children}</td>;
  return (
    <td className={`${className} copyable${copied ? " copied" : ""}`} title={`Click to copy ${what}`}
        onClick={async () => {
          if (String(getSelection())) return;
          await copyText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 700);
        }}>
      {children}
    </td>
  );
}
