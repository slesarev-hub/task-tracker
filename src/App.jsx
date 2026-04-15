import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

// ── Constants ────────────────────────────────────────────────────────────────
const LS_KEY = "task-tracker-v1";
const LS_GSHEET = "task-tracker-gsheet";
const LS_CLIENT = "task-tracker-client-id";
const LS_TOKEN = "task-tracker-token";
const LS_LAST_SYNC = "task-tracker-last-sync";
const LS_EXPANDED = "task-tracker-expanded";
const LS_USER_EMAIL = "task-tracker-user-email";
const LS_NOTES_LIST_WIDTH = "task-tracker-notes-list-width";
const LS_NOTES_LIST_COLLAPSED = "task-tracker-notes-list-collapsed";

// A task is considered a child only if parentId is a non-empty string.
// Empty strings or whitespace must be treated as top-level.
const hasParent = (t) => Boolean(t && t.parentId && String(t.parentId).trim());
const SCOPES = "https://www.googleapis.com/auth/spreadsheets openid email";

// Merge local and remote using pure UNION semantics: items present on either
// side are always kept. If the same id appears in both, whichever has a newer
// updatedAt wins. This is intentionally non-lossy — delete propagation is
// sacrificed to prevent data loss from sync races or mismatched app versions.
// (Proper delete propagation would require tombstones, added later.)
const mergeData = (local, remote) => {
  const mergeItems = (localItems, remoteItems) => {
    const localById = new Map((localItems || []).map((i) => [i.id, i]));
    const remoteById = new Map((remoteItems || []).map((i) => [i.id, i]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
    const merged = [];
    for (const id of allIds) {
      const l = localById.get(id);
      const r = remoteById.get(id);
      if (l && r) {
        // Both present → take whichever has newer updatedAt (ties prefer local)
        const lTime = l.updatedAt || "";
        const rTime = r.updatedAt || "";
        const winner = lTime >= rTime ? l : r;
        // parentId regression guard: since there's no UI to "unparent" a task,
        // losing parentId is always a bug. If either side still has it, keep it.
        const lPid = (l.parentId && String(l.parentId).trim()) || null;
        const rPid = (r.parentId && String(r.parentId).trim()) || null;
        let parentId = winner.parentId || null;
        if (lPid && !rPid) parentId = lPid;
        else if (!lPid && rPid) parentId = rPid;
        merged.push({ ...winner, parentId });
      } else if (l) {
        merged.push(l);
      } else if (r) {
        merged.push(r);
      }
    }
    return merged;
  };

  return {
    projects: mergeItems(local.projects, remote.projects),
    tasks: mergeItems(local.tasks, remote.tasks),
    notes: mergeItems(local.notes || [], remote.notes || []),
  };
};

// Load a valid (non-expired) stored token, if any
const loadStoredToken = () => {
  try {
    const raw = localStorage.getItem(LS_TOKEN);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.expiresAt) return null;
    if (Date.now() >= parsed.expiresAt - 30000) return null; // 30s buffer
    return parsed;
  } catch {
    return null;
  }
};

const COLUMNS = [
  { id: "todo", label: "To Do", color: "#6b7280" },
  { id: "inProgress", label: "In Progress", color: "#3b82f6" },
  { id: "done", label: "Done", color: "#22c55e" },
  { id: "cancelled", label: "Cancelled", color: "#ef4444" },
];

const PRIORITIES = [
  { id: "urgent", label: "Urgent", short: "!", color: "#ef4444", hint: "Do today" },
  { id: "soon", label: "Soon", short: "~", color: "#f59e0b", hint: "Next few weeks" },
  { id: "none", label: "No rush", short: "·", color: "#4b5563", hint: "No deadline" },
];
const PRIORITY_RANK = { urgent: 0, soon: 1, none: 2 };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const now = () => new Date().toISOString();

// Tab → 2 spaces in a controlled textarea. Shift+Tab removes up to 2 spaces
// before the cursor. Keeps cursor position consistent after React re-renders.
const handleTabIndent = (e, currentValue, setValue) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const el = e.target;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const TAB = "  ";
  if (e.shiftKey) {
    const before = currentValue.slice(0, start);
    const m = before.match(/ {1,2}$/);
    if (!m) return;
    const removeLen = m[0].length;
    setValue(currentValue.slice(0, start - removeLen) + currentValue.slice(start));
    requestAnimationFrame(() => {
      try {
        el.selectionStart = el.selectionEnd = Math.max(0, start - removeLen);
      } catch {}
    });
    return;
  }
  setValue(currentValue.slice(0, start) + TAB + currentValue.slice(end));
  requestAnimationFrame(() => {
    try {
      el.selectionStart = el.selectionEnd = start + TAB.length;
    } catch {}
  });
};

// Lightweight inline renderer for task card previews: turns `code` spans into
// styled inline code while leaving everything else as plain text. We don't want
// the full markdown machinery on each card; this is just enough for the common
// "command name in backticks" case.
const renderInlinePreview = (text) => {
  if (!text) return null;
  const parts = [];
  const regex = /`([^`\n]+)`/g;
  let lastIdx = 0;
  let match;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    parts.push(<code key={key++} className="inline-code">{match[1]}</code>);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
};

// Custom renderers for ReactMarkdown: wrap fenced code blocks in a figure with
// a small language label in the top-right corner.
const DIAGRAM_LANGS = new Set(["diagram", "text", "ascii", "txt", "scheme", "box"]);

const markdownComponents = {
  code({ inline, className, children, ...props }) {
    if (inline) {
      return <code className={className} {...props}>{children}</code>;
    }
    const match = /language-([\w-]+)/.exec(className || "");
    const lang = match ? match[1] : "";
    const isDiagram = DIAGRAM_LANGS.has(lang);
    return (
      <div className={`code-block-wrap${isDiagram ? " diagram-block" : ""}`}>
        {lang && <div className="code-block-lang">{isDiagram ? (lang === "txt" || lang === "text" ? "text" : lang) : lang}</div>}
        <pre>
          <code className={isDiagram ? undefined : className} {...props}>{children}</code>
        </pre>
      </div>
    );
  },
  pre({ children }) {
    // The custom `code` above already renders its own <pre>, so pass through
    return <>{children}</>;
  },
};

// ── Hooks ────────────────────────────────────────────────────────────────────
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

// ── Sheets API ───────────────────────────────────────────────────────────────
const sheetsGet = async (token, sid, range) => {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Sheets GET ${r.status}`);
  return r.json();
};
const sheetsClear = async (token, sid, range) => {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}:clear`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
};
const sheetsUpdate = async (token, sid, range, values) => {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!r.ok) throw new Error(`Sheets update failed: ${r.status}`);
};
const sheetsBatchUpdate = async (token, sid, data) => {
  if (!data.length) return;
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    }
  );
  if (!r.ok) throw new Error(`Sheets batchUpdate failed: ${r.status}`);
  return r.json();
};
const sheetsAppend = async (token, sid, range, values) => {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!r.ok) throw new Error(`Sheets append failed: ${r.status}`);
  return r.json();
};

// Row converters — single source of truth for sheet column layouts
const projectToRow = (p) => [p.id || "", p.name || "", p.createdAt || "", p.updatedAt || "", p.notes || ""];
const taskToRow = (t) => [
  t.id || "",
  t.projectId || "",
  t.title || "",
  t.column || "",
  String(t.order ?? 0),
  t.createdAt || "",
  t.updatedAt || "",
  t.description || "",
  t.priority || "none",
  t.parentId || "",
];
const PROJECTS_HEADER = ["id", "name", "createdAt", "updatedAt", "notes"];
const TASKS_HEADER = ["id", "projectId", "title", "column", "order", "createdAt", "updatedAt", "description", "priority", "parentId"];
const NOTES_HEADER = ["id", "projectId", "taskId", "title", "body", "createdAt", "updatedAt"];
const noteToRow = (n) => [
  n.id || "",
  n.projectId || "",
  n.taskId || "",
  n.title || "",
  n.body || "",
  n.createdAt || "",
  n.updatedAt || "",
];
const createSpreadsheet = async (token) => {
  const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "Task Tracker" },
      sheets: [
        { properties: { title: "Projects" } },
        { properties: { title: "Tasks" } },
        { properties: { title: "Notes" } },
      ],
    }),
  });
  if (!r.ok) throw new Error("Cannot create spreadsheet");
  return (await r.json()).spreadsheetId;
};
// Cache of spreadsheet IDs where we've already confirmed the Notes tab exists,
// so we don't hit the API on every diff push.
const _ensuredNotesSheets = new Set();
// Ensure the Notes sheet exists in an existing spreadsheet (idempotent)
const ensureNotesSheet = async (token, sid) => {
  if (_ensuredNotesSheets.has(sid)) return true;
  try {
    // Try to read the Notes sheet; if it fails, assume it doesn't exist
    await sheetsGet(token, sid, "Notes!A1:A1");
    _ensuredNotesSheets.add(sid);
    return true;
  } catch {
    // Create via batchUpdate
    try {
      const r = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{ addSheet: { properties: { title: "Notes" } } }],
          }),
        }
      );
      if (r.ok) {
        _ensuredNotesSheets.add(sid);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
};
// Migrate legacy embedded subtasks into flat tasks with parentId
const migrateTasks = (rawTasks) => {
  const out = [];
  for (const t of rawTasks || []) {
    const { subtasks, ...rest } = t;
    out.push({
      ...rest,
      parentId: rest.parentId || null,
      priority: rest.priority || "none",
    });
    if (Array.isArray(subtasks) && subtasks.length > 0) {
      subtasks.forEach((s, i) => {
        if (!s || !s.title) return;
        out.push({
          id: s.id || (Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + i),
          projectId: t.projectId,
          parentId: t.id,
          title: s.title,
          description: "",
          column: s.done ? "done" : (t.column || "todo"),
          priority: "none",
          order: i,
          createdAt: t.createdAt || new Date().toISOString(),
          updatedAt: t.updatedAt || new Date().toISOString(),
        });
      });
    }
  }
  return out;
};

// Read sheets and return data plus per-id → row-index maps.
// Empty rows (no id) are skipped but their row slot is not reused.
const readFromSheets = async (token, sid) => {
  const [projRes, taskRes, notesRes] = await Promise.all([
    sheetsGet(token, sid, "Projects!A2:E"),
    sheetsGet(token, sid, "Tasks!A2:J"),
    // Notes sheet may not exist in older spreadsheets — treat failure as empty
    sheetsGet(token, sid, "Notes!A2:G").catch(() => ({ values: [] })),
  ]);
  const projects = [];
  const projRowMap = new Map();
  (projRes.values || []).forEach((row, idx) => {
    if (!row || !row[0]) return;
    const [id, name, createdAt, updatedAt, notes] = row;
    projects.push({ id, name, createdAt, updatedAt, notes: notes || "" });
    projRowMap.set(id, idx + 2); // row 1 is header, data starts at row 2
  });
  const tasksRaw = [];
  const taskRowMap = new Map();
  (taskRes.values || []).forEach((row, idx) => {
    if (!row || !row[0]) return;
    const [id, projectId, title, column, order, createdAt, updatedAt, description, priority, colJ] = row;
    // Column J may contain legacy subtasks JSON or new parentId string
    let parentId = null;
    let legacySubtasks = null;
    if (colJ && typeof colJ === "string") {
      const trimmed = colJ.trim();
      if (trimmed.startsWith("[")) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr) && arr.length > 0) legacySubtasks = arr;
        } catch {}
      } else if (trimmed) {
        parentId = trimmed;
      }
    }
    tasksRaw.push({
      id, projectId, title, column, order: parseFloat(order),
      createdAt, updatedAt,
      description: description || "",
      priority: priority || "none",
      parentId,
      ...(legacySubtasks ? { subtasks: legacySubtasks } : {}),
    });
    taskRowMap.set(id, idx + 2);
  });
  // migrateTasks may add tasks (legacy subtask children). Those don't yet have
  // sheet rows — they'll be appended on the next diff push.
  const tasks = migrateTasks(tasksRaw);
  const notes = [];
  const notesRowMap = new Map();
  (notesRes.values || []).forEach((row, idx) => {
    if (!row || !row[0]) return;
    const [id, projectId, taskId, title, body, createdAt, updatedAt] = row;
    notes.push({
      id,
      projectId,
      taskId: taskId || null,
      title: title || "",
      body: body || "",
      createdAt,
      updatedAt,
    });
    notesRowMap.set(id, idx + 2);
  });
  return {
    projects,
    tasks,
    notes,
    rowMaps: { projects: projRowMap, tasks: taskRowMap, notes: notesRowMap },
  };
};

// Full rewrite: only used for first-time init and Force push escape hatch.
const writeToSheets = async (token, sid, data) => {
  // Make sure Notes tab exists before we try to write to it
  await ensureNotesSheet(token, sid);
  await sheetsClear(token, sid, "Projects!A1:Z");
  await sheetsClear(token, sid, "Tasks!A1:Z");
  await sheetsClear(token, sid, "Notes!A1:Z");
  await sheetsUpdate(token, sid, "Projects!A1", [
    PROJECTS_HEADER,
    ...data.projects.map(projectToRow),
  ]);
  await sheetsUpdate(token, sid, "Tasks!A1", [
    TASKS_HEADER,
    ...data.tasks.map(taskToRow),
  ]);
  await sheetsUpdate(token, sid, "Notes!A1", [
    NOTES_HEADER,
    ...(data.notes || []).map(noteToRow),
  ]);
};

// Push only the diff between a prev baseline and the next state.
// rowMap maps id → sheet row number (1-based); it is mutated in place as
// appends return their assigned row. The caller must have already populated
// rowMap via a successful readFromSheets or force rewrite.
const diffPushToSheets = async (token, sid, prev, next, rowMap) => {
  // Make sure the Notes tab exists before we try to write to it — cached so
  // this is a no-op after the first call per spreadsheet.
  await ensureNotesSheet(token, sid);
  const batchData = [
    // Always keep the header in sync — cheap and idempotent.
    { range: "Projects!A1:E1", values: [PROJECTS_HEADER] },
    { range: "Tasks!A1:J1", values: [TASKS_HEADER] },
    { range: "Notes!A1:G1", values: [NOTES_HEADER] },
  ];
  const appendProjects = [];
  const appendTasks = [];
  const appendNotes = [];

  const diffItems = (prevItems, nextItems, sheetName, cols, toRow, isChanged, map, appendBucket) => {
    const prevById = new Map((prevItems || []).map((i) => [i.id, i]));
    const nextById = new Map((nextItems || []).map((i) => [i.id, i]));
    const emptyRow = new Array(cols).fill("");
    const allIds = new Set([...prevById.keys(), ...nextById.keys()]);
    for (const id of allIds) {
      const p = prevById.get(id);
      const n = nextById.get(id);
      const row = map.get(id);
      const lastCol = String.fromCharCode("A".charCodeAt(0) + cols - 1);
      if (n && !p) {
        if (row) {
          batchData.push({ range: `${sheetName}!A${row}:${lastCol}${row}`, values: [toRow(n)] });
        } else {
          appendBucket.push(n);
        }
      } else if (p && !n) {
        if (row) {
          batchData.push({ range: `${sheetName}!A${row}:${lastCol}${row}`, values: [emptyRow] });
          map.delete(id);
        }
      } else if (p && n) {
        if (isChanged(p, n)) {
          if (row) {
            batchData.push({ range: `${sheetName}!A${row}:${lastCol}${row}`, values: [toRow(n)] });
          } else {
            appendBucket.push(n);
          }
        }
      }
    }
  };

  const projectChanged = (a, b) =>
    a.updatedAt !== b.updatedAt || a.name !== b.name || (a.notes || "") !== (b.notes || "");
  const taskChanged = (a, b) =>
    a.updatedAt !== b.updatedAt ||
    (a.parentId || "") !== (b.parentId || "") ||
    a.column !== b.column ||
    a.order !== b.order;
  const noteChanged = (a, b) =>
    a.updatedAt !== b.updatedAt ||
    a.title !== b.title ||
    (a.taskId || "") !== (b.taskId || "") ||
    (a.body || "") !== (b.body || "");

  diffItems(prev.projects, next.projects, "Projects", 5, projectToRow, projectChanged, rowMap.projects, appendProjects);
  diffItems(prev.tasks, next.tasks, "Tasks", 10, taskToRow, taskChanged, rowMap.tasks, appendTasks);
  diffItems(prev.notes || [], next.notes || [], "Notes", 7, noteToRow, noteChanged, rowMap.notes || new Map(), appendNotes);

  if (batchData.length > 2) {
    // More than just headers → actually write
    await sheetsBatchUpdate(token, sid, batchData);
  } else {
    // Only headers — still write them once to keep the sheet labelled
    await sheetsBatchUpdate(token, sid, batchData);
  }

  for (const p of appendProjects) {
    const res = await sheetsAppend(token, sid, "Projects!A1:E1", [projectToRow(p)]);
    const rng = res?.updates?.updatedRange || "";
    const m = rng.match(/!A(\d+)/);
    if (m) rowMap.projects.set(p.id, parseInt(m[1], 10));
  }
  for (const t of appendTasks) {
    const res = await sheetsAppend(token, sid, "Tasks!A1:J1", [taskToRow(t)]);
    const rng = res?.updates?.updatedRange || "";
    const m = rng.match(/!A(\d+)/);
    if (m) rowMap.tasks.set(t.id, parseInt(m[1], 10));
  }
  if (!rowMap.notes) rowMap.notes = new Map();
  for (const n of appendNotes) {
    const res = await sheetsAppend(token, sid, "Notes!A1:G1", [noteToRow(n)]);
    const rng = res?.updates?.updatedRange || "";
    const m = rng.match(/!A(\d+)/);
    if (m) rowMap.notes.set(n.id, parseInt(m[1], 10));
  }
};

// ── Task Card body (shared by Sortable and Static wrappers) ──────────────────
function TaskCardBody({
  task, onEdit, onDelete, onView, onCopy,
  childCount, childDoneCount,
  expanded, onToggleExpand,
  depth = 0,
  highlighted = false,
  copiedId = null,
  setNodeRef, style, listeners, attributes,
}) {
  const priority = task.priority || "none";
  const priorityDef = PRIORITIES.find((p) => p.id === priority);
  const descPreview = task.description ? task.description.split("\n").find((l) => l.trim()) || "" : "";
  const hasMoreDesc = task.description && task.description.includes("\n");
  const combinedStyle = {
    ...(style || {}),
    "--priority-color": priorityDef.color,
  };
  return (
    <div
      ref={setNodeRef}
      style={combinedStyle}
      {...(attributes || {})}
      {...(listeners || {})}
      className={`task-card priority-${priority} col-${task.column}${depth > 0 ? " task-card-child" : ""}${highlighted ? " highlighted" : ""}`}
      data-depth={depth || 0}
      data-task-id={task.id}
      onClick={() => onView(task)}
    >
      <div className="task-title">{task.title}</div>
      {descPreview && (
        <div className="task-desc">
          {renderInlinePreview(descPreview)}{hasMoreDesc && " …"}
        </div>
      )}
      <div className="task-badges">
        {priority !== "none" && (
          <span className="task-priority-badge" style={{ color: priorityDef.color }}>
            {priorityDef.label}
          </span>
        )}
        {childCount > 0 && (
          <button
            type="button"
            className={`task-subtasks-progress${childDoneCount === childCount ? " all-done" : ""}${expanded ? " expanded" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(task.id);
            }}
            title={expanded ? "Collapse subtasks" : "Expand subtasks"}
          >
            <span className="expand-arrow">{expanded ? "▾" : "▸"}</span>
            {childDoneCount}/{childCount}
          </button>
        )}
      </div>
      <div className="task-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="btn-icon"
          onClick={(e) => { e.stopPropagation(); onCopy && onCopy(task); }}
          title="Copy title"
        >
          {copiedId === `card-${task.id}` ? "\u2713" : "\u2398"}
        </button>
        <button className="btn-icon" onClick={(e) => { e.stopPropagation(); onEdit(task); }} title="Edit">&#9998;</button>
        <button className="btn-icon btn-del" onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} title="Delete">&times;</button>
      </div>
    </div>
  );
}

// Draggable wrapper for top-level tasks on the board
function SortableTask(props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
    data: { type: "task", task: props.task },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <TaskCardBody
      {...props}
      setNodeRef={setNodeRef}
      style={style}
      listeners={listeners}
      attributes={attributes}
    />
  );
}

// Non-draggable static wrapper for expanded inline children
function StaticTask(props) {
  return <TaskCardBody {...props} />;
}

// ── Droppable Column ─────────────────────────────────────────────────────────
function ColumnDropZone({ columnId, children }) {
  const { setNodeRef } = useDroppable({
    id: `column:${columnId}`,
    data: { type: "column", columnId },
  });
  return <div ref={setNodeRef} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minHeight: 60 }}>{children}</div>;
}

function Column({
  col, tasks, onEdit, onDelete, onAdd, onView, onCopy, childStats,
  expandedIds, onToggleExpand, getChildren, highlightedTaskId, copiedTarget,
  visibleTaskIds,
}) {
  const taskIds = tasks.map((t) => t.id);

  // Recursively render children of a given parent
  const renderChildrenOf = (parentId, depth) => {
    const allChildren = getChildren(parentId);
    const children = visibleTaskIds
      ? allChildren.filter((c) => visibleTaskIds.has(c.id))
      : allChildren;
    if (children.length === 0) return null;
    return children.map((c) => (
      <Fragment key={c.id}>
        <StaticTask
          task={c}
          onEdit={onEdit}
          onDelete={onDelete}
          onView={onView}
          onCopy={onCopy}
          copiedId={copiedTarget}
          childCount={childStats[c.id]?.count || 0}
          childDoneCount={childStats[c.id]?.done || 0}
          expanded={expandedIds.has(c.id)}
          onToggleExpand={onToggleExpand}
          depth={depth}
          highlighted={highlightedTaskId === c.id}
        />
        {expandedIds.has(c.id) && renderChildrenOf(c.id, depth + 1)}
      </Fragment>
    ));
  };

  const visibleTopTasks = visibleTaskIds
    ? tasks.filter((t) => visibleTaskIds.has(t.id))
    : tasks;
  return (
    <div className="column">
      <div className="column-header" style={{ borderBottomColor: col.color }}>
        <span className="column-title">{col.label}</span>
        <span className="column-count">
          {visibleTaskIds ? `${visibleTopTasks.length}/${tasks.length}` : tasks.length}
        </span>
      </div>
      <div className="column-body">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <ColumnDropZone columnId={col.id}>
            {visibleTopTasks.map((t) => (
              <Fragment key={t.id}>
                <SortableTask
                  task={t}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onView={onView}
                  onCopy={onCopy}
                  copiedId={copiedTarget}
                  childCount={childStats[t.id]?.count || 0}
                  childDoneCount={childStats[t.id]?.done || 0}
                  expanded={expandedIds.has(t.id)}
                  onToggleExpand={onToggleExpand}
                  highlighted={highlightedTaskId === t.id}
                />
                {expandedIds.has(t.id) && renderChildrenOf(t.id, 1)}
              </Fragment>
            ))}
          </ColumnDropZone>
        </SortableContext>
        <button className="btn-add-task" onClick={() => onAdd(col.id)}>+ Add task</button>
      </div>
    </div>
  );
}

// ── Hash routing ─────────────────────────────────────────────────────────────
const parseHash = () => {
  const h = (typeof window !== "undefined" ? window.location.hash.slice(1) : "") || "/";
  // /p/:id/notes/:noteId
  const mn = h.match(/^\/p\/([^/?#]+)\/notes(?:\/([^/?#]+))?$/);
  if (mn) return { view: "board", activeProjectId: mn[1], viewingTaskId: null, projectMode: "notes", activeNoteId: mn[2] || null };
  // /p/:id/t/:tid
  const m = h.match(/^\/p\/([^/?#]+)(?:\/t\/([^/?#]+))?$/);
  if (m) return { view: "board", activeProjectId: m[1], viewingTaskId: m[2] || null, projectMode: "board", activeNoteId: null };
  return { view: "projects", activeProjectId: null, viewingTaskId: null, projectMode: "board", activeNoteId: null };
};
const buildHash = (view, activeProjectId, viewingTaskId, projectMode, activeNoteId) => {
  if (view === "board" && activeProjectId) {
    if (projectMode === "notes") {
      return activeNoteId
        ? `#/p/${activeProjectId}/notes/${activeNoteId}`
        : `#/p/${activeProjectId}/notes`;
    }
    return viewingTaskId
      ? `#/p/${activeProjectId}/t/${viewingTaskId}`
      : `#/p/${activeProjectId}`;
  }
  return "#/";
};

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return { projects: [], tasks: [], notes: [] };
      const parsed = JSON.parse(raw);
      return {
        ...parsed,
        tasks: migrateTasks(parsed.tasks),
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      };
    } catch {
      return { projects: [], tasks: [], notes: [] };
    }
  });
  const initialRoute = parseHash();
  const [view, setView] = useState(initialRoute.view); // "projects" | "board"
  const [activeProjectId, setActiveProjectId] = useState(initialRoute.activeProjectId);
  const [viewingTaskId, setViewingTaskId] = useState(initialRoute.viewingTaskId);
  const [modal, setModal] = useState(null);
  const [modalValue, setModalValue] = useState("");
  const [modalDesc, setModalDesc] = useState("");
  const [editingTask, setEditingTask] = useState(null);
  const [editPreview, setEditPreview] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [highlightedTaskId, setHighlightedTaskId] = useState(null);
  const highlightTimerRef = useRef(null);
  const [boardSearch, setBoardSearch] = useState("");
  const [projectMode, setProjectMode] = useState(initialRoute.projectMode || "board"); // "board" | "notes"
  const [activeNoteId, setActiveNoteId] = useState(initialRoute.activeNoteId || null);
  const [noteEditorPreview, setNoteEditorPreview] = useState(false);
  const [notesListWidth, setNotesListWidth] = useState(() => {
    const v = parseInt(localStorage.getItem(LS_NOTES_LIST_WIDTH) || "280", 10);
    return Number.isFinite(v) && v >= 160 ? v : 280;
  });
  const [notesListCollapsed, setNotesListCollapsed] = useState(
    () => localStorage.getItem(LS_NOTES_LIST_COLLAPSED) === "1"
  );
  useEffect(() => {
    try { localStorage.setItem(LS_NOTES_LIST_WIDTH, String(notesListWidth)); } catch {}
  }, [notesListWidth]);
  useEffect(() => {
    try { localStorage.setItem(LS_NOTES_LIST_COLLAPSED, notesListCollapsed ? "1" : "0"); } catch {}
  }, [notesListCollapsed]);
  const notesPanelRef = useRef(null);
  // Pointer-based resizer for the notes list
  const onNotesResizeStart = useCallback((e) => {
    e.preventDefault();
    const panel = notesPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const onMove = (ev) => {
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const clamped = Math.max(160, Math.min(rect.width - 300, x));
      setNotesListWidth(clamped);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  const activeNote = activeNoteId
    ? (data.notes || []).find((n) => n.id === activeNoteId)
    : null;
  const [notesFullscreen, setNotesFullscreen] = useState(false);
  // Close notes fullscreen on Esc
  useEffect(() => {
    if (!notesFullscreen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setNotesFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notesFullscreen]);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchIdx, setGlobalSearchIdx] = useState(0);
  const globalSearchInputRef = useRef(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [notesPreview, setNotesPreview] = useState(false);
  const updateProjectNotes = useCallback((projectId, notes) => {
    save({
      ...dataRef.current,
      projects: dataRef.current.projects.map((p) =>
        p.id === projectId ? { ...p, notes, updatedAt: now() } : p
      ),
    });
  }, []);

  // ── Notes (linked to project / optionally a task) ──────────────────────
  const createNote = useCallback((projectId, taskId = null, title = "New note") => {
    const t = now();
    const note = {
      id: uid(),
      projectId,
      taskId,
      title,
      body: "",
      createdAt: t,
      updatedAt: t,
    };
    save({
      ...dataRef.current,
      notes: [...(dataRef.current.notes || []), note],
    });
    return note.id;
  }, []);
  const updateNote = useCallback((id, patch) => {
    save({
      ...dataRef.current,
      notes: (dataRef.current.notes || []).map((n) =>
        n.id === id ? { ...n, ...patch, updatedAt: now() } : n
      ),
    });
  }, []);
  const deleteNote = useCallback((id) => {
    save({
      ...dataRef.current,
      notes: (dataRef.current.notes || []).filter((n) => n.id !== id),
    });
  }, []);
  const [copiedTarget, setCopiedTarget] = useState(null);
  const copyTimerRef = useRef(null);
  const copyText = useCallback(async (text, target) => {
    try {
      await navigator.clipboard.writeText(text || "");
      setCopiedTarget(target);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedTarget(null), 1200);
    } catch {}
  }, []);
  const [expandedIds, setExpandedIds] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_EXPANDED);
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set();
  });
  // Persist expansion state across reloads
  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED, JSON.stringify([...expandedIds])); } catch {}
  }, [expandedIds]);
  const skipHashSync = useRef(false);

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Open a task inside its project board and briefly flash it so the user
  // can find it visually. Expands every ancestor so it's actually visible.
  const focusTaskInBoard = useCallback((task) => {
    if (!task) return;
    // Expand all ancestors
    const ancestors = [];
    let cur = task;
    while (cur && cur.parentId) {
      ancestors.push(cur.parentId);
      cur = dataRef.current.tasks.find((t) => t.id === cur.parentId);
    }
    if (ancestors.length > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of ancestors) next.add(id);
        return next;
      });
    }
    setActiveProjectId(task.projectId);
    setView("board");
    setHighlightedTaskId(task.id);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedTaskId(null), 2500);
  }, []);

  // Scroll the highlighted card into view once it's been rendered
  useEffect(() => {
    if (!highlightedTaskId) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-task-id="${highlightedTaskId}"]`);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightedTaskId]);

  // Global search — Ctrl/Cmd+K opens popover, Esc closes
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setGlobalSearchOpen(true);
        setGlobalSearchQuery("");
        setGlobalSearchIdx(0);
        setTimeout(() => globalSearchInputRef.current?.focus(), 0);
        return;
      }
      if (e.key === "Escape" && globalSearchOpen) {
        e.preventDefault();
        setGlobalSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [globalSearchOpen]);
  // Click-outside closes the popover (ignore clicks on the trigger itself)
  useEffect(() => {
    if (!globalSearchOpen) return;
    const onDocClick = (e) => {
      const popover = document.querySelector(".global-search-popover");
      const trigger = document.querySelector(".global-search-trigger");
      if (popover && popover.contains(e.target)) return;
      if (trigger && trigger.contains(e.target)) return;
      setGlobalSearchOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [globalSearchOpen]);

  // Ranked global search results across tasks + project notes + project names
  const globalSearchResults = (() => {
    const q = globalSearchQuery.trim().toLowerCase();
    if (!q || !globalSearchOpen) return [];
    const results = [];
    for (const t of data.tasks) {
      const title = (t.title || "").toLowerCase();
      const desc = (t.description || "").toLowerCase();
      const titleMatch = title.includes(q);
      const descMatch = desc.includes(q);
      if (titleMatch || descMatch) {
        results.push({
          kind: "task",
          task: t,
          titleMatch,
          descMatch,
          score: titleMatch ? 3 : 1,
        });
      }
    }
    for (const p of data.projects) {
      const name = (p.name || "").toLowerCase();
      const notes = (p.notes || "").toLowerCase();
      const nameMatch = name.includes(q);
      const notesMatch = notes.includes(q);
      if (nameMatch || notesMatch) {
        results.push({
          kind: "project",
          project: p,
          nameMatch,
          notesMatch,
          score: nameMatch ? 4 : 2,
        });
      }
    }
    for (const n of data.notes || []) {
      const title = (n.title || "").toLowerCase();
      const body = (n.body || "").toLowerCase();
      const titleMatch = title.includes(q);
      const bodyMatch = body.includes(q);
      if (titleMatch || bodyMatch) {
        results.push({
          kind: "note",
          note: n,
          titleMatch,
          bodyMatch,
          score: titleMatch ? 3 : 1,
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 80);
  })();

  // Snippet extractor: show ~90 chars of text around the match
  const extractSnippet = (text, query, len = 90) => {
    if (!text) return "";
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text.slice(0, len);
    const start = Math.max(0, idx - 30);
    const end = Math.min(text.length, idx + query.length + 60);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  };

  // Highlight match inside a short text by splitting around query occurrence
  const highlightMatch = (text, query) => {
    if (!text || !query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="search-match">{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  };

  const openSearchResult = (r) => {
    setGlobalSearchOpen(false);
    if (r.kind === "task") {
      focusTaskInBoard(r.task);
    } else if (r.kind === "project") {
      setActiveProjectId(r.project.id);
      setView("board");
    } else if (r.kind === "note") {
      setActiveProjectId(r.note.projectId);
      setView("board");
      setProjectMode("notes");
      setActiveNoteId(r.note.id);
    }
  };

  // Keyboard navigation inside search modal
  const onGlobalSearchKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setGlobalSearchIdx((i) => Math.min(globalSearchResults.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setGlobalSearchIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = globalSearchResults[globalSearchIdx];
      if (r) openSearchResult(r);
    }
  };

  // Mobile & online state
  const isMobile = useMediaQuery("(max-width: 640px)");
  const [mobileCol, setMobileCol] = useState("todo");
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Google sync state
  const [syncStatus, setSyncStatus] = useState("idle");
  const [token, setToken] = useState(() => loadStoredToken()?.token || null);
  const [clientId, setClientId] = useState(() => localStorage.getItem(LS_CLIENT) || "");
  const [sheetId, setSheetId] = useState(() => localStorage.getItem(LS_GSHEET) || "");
  const [showSetup, setShowSetup] = useState(false);
  const gsiLoaded = useRef(false);
  const tokenClient = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const refreshTimer = useRef(null);
  const feedRef = useRef(null);
  const syncFromSheetsRef = useRef(null);
  // Per-row sync bookkeeping
  const rowMapRef = useRef({ projects: new Map(), tasks: new Map(), notes: new Map() });
  const prevSyncedRef = useRef({ projects: [], tasks: [], notes: [] });
  const syncedOnceRef = useRef(false);
  const pushTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const pushInFlightRef = useRef(false);

  // Persist migrated localStorage data once (if legacy embedded subtasks were present)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const wasLegacy = (parsed.tasks || []).some(
        (t) => Array.isArray(t.subtasks) && t.subtasks.length > 0
      );
      if (wasLegacy) {
        localStorage.setItem(LS_KEY, JSON.stringify({ ...parsed, tasks: migrateTasks(parsed.tasks) }));
      }
    } catch {}
  }, []);

  // ── Route persistence: sync state ↔ URL hash ─────────────────────────────
  // state → hash
  useEffect(() => {
    const desired = buildHash(view, activeProjectId, viewingTaskId, projectMode, activeNoteId);
    if (window.location.hash !== desired && !(desired === "#/" && window.location.hash === "")) {
      skipHashSync.current = true;
      window.location.hash = desired;
    }
  }, [view, activeProjectId, viewingTaskId, projectMode, activeNoteId]);
  // hash → state (browser back/forward)
  useEffect(() => {
    const onHashChange = () => {
      if (skipHashSync.current) {
        skipHashSync.current = false;
        return;
      }
      const s = parseHash();
      setView(s.view);
      setActiveProjectId(s.activeProjectId);
      setViewingTaskId(s.viewingTaskId);
      setProjectMode(s.projectMode || "board");
      setActiveNoteId(s.activeNoteId || null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Safeguard: if URL references a missing project or task, fall back cleanly
  useEffect(() => {
    if (view === "board" && activeProjectId && !data.projects.find((p) => p.id === activeProjectId)) {
      setView("projects");
      setActiveProjectId(null);
      setViewingTaskId(null);
      return;
    }
    if (viewingTaskId && !data.tasks.find((t) => t.id === viewingTaskId)) {
      setViewingTaskId(null);
    }
  }, [view, activeProjectId, viewingTaskId, data.projects, data.tasks]);

  // Online/offline detection + full sync on reconnect
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (token && sheetId) {
        // Trigger a full merge-sync instead of a blind push
        setTimeout(() => { syncFromSheetsRef.current?.(); }, 0);
      }
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [token, sheetId]);

  // Debounced, serialized diff-push flush.
  // Multiple rapid save() calls coalesce into a single push of the latest state.
  // Only one push runs at a time; if a new save arrives mid-flight, it reruns
  // after the current push finishes.
  const flushPush = useCallback(async () => {
    if (!token || !sheetId) return;
    if (!syncedOnceRef.current) return; // wait for first pull-sync
    if (pushInFlightRef.current) {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      pushTimerRef.current = setTimeout(flushPush, 500);
      return;
    }
    const toSave = pendingSaveRef.current;
    if (!toSave) return;
    pendingSaveRef.current = null;
    pushInFlightRef.current = true;
    setSyncStatus("syncing");
    try {
      await diffPushToSheets(token, sheetId, prevSyncedRef.current, toSave, rowMapRef.current);
      prevSyncedRef.current = toSave;
      try { localStorage.setItem(LS_LAST_SYNC, String(Date.now())); } catch {}
      setSyncStatus("ok");
    } catch (e) {
      console.error("diffPushToSheets failed", e);
      setSyncStatus("error");
    } finally {
      pushInFlightRef.current = false;
      if (pendingSaveRef.current) {
        if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
        pushTimerRef.current = setTimeout(flushPush, 500);
      }
    }
  }, [token, sheetId]);

  // Save helper
  const save = useCallback(
    (next) => {
      // Safety net: refuse to save a state that drops >80% of existing items
      // without explicit intent. Prevents accidental wipes from stale/empty
      // memory state clobbering populated localStorage/remote.
      const curr = dataRef.current || { projects: [], tasks: [] };
      const currCount = (curr.tasks?.length || 0) + (curr.projects?.length || 0);
      const nextCount = (next.tasks?.length || 0) + (next.projects?.length || 0);
      if (currCount >= 5 && nextCount < currCount * 0.2) {
        console.error(
          "save() refused: state would shrink from",
          currCount,
          "to",
          nextCount,
          "items. Likely a bug."
        );
        setSyncStatus("error");
        return;
      }
      setData(next);
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
      if (token && sheetId && syncedOnceRef.current) {
        pendingSaveRef.current = next;
        if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
        pushTimerRef.current = setTimeout(flushPush, 500);
      }
    },
    [token, sheetId, flushPush]
  );

  // ── Google Auth ──────────────────────────────────────────────────────────
  const initTokenClient = useCallback(() => {
    if (!window.google || !clientId) return;
    const storedHint = localStorage.getItem(LS_USER_EMAIL) || undefined;
    tokenClient.current = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      // Pre-fill account hint to skip the "select account" chooser on re-auth
      ...(storedHint ? { hint: storedHint } : {}),
      callback: (resp) => {
        if (resp.access_token) {
          const expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          setToken(resp.access_token);
          try {
            localStorage.setItem(LS_TOKEN, JSON.stringify({ token: resp.access_token, expiresAt }));
          } catch {}
          // Fetch user email once so next login can use it as hint
          if (!localStorage.getItem(LS_USER_EMAIL)) {
            fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
              headers: { Authorization: `Bearer ${resp.access_token}` },
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((info) => {
                if (info && info.email) {
                  try { localStorage.setItem(LS_USER_EMAIL, info.email); } catch {}
                }
              })
              .catch(() => {});
          }
        }
      },
      error_callback: () => {
        // Silent refresh failed or user dismissed — leave token null
      },
    });
    // Try silent refresh if user previously consented but stored token is gone/expired
    if (!loadStoredToken() && localStorage.getItem(LS_TOKEN)) {
      try { tokenClient.current.requestAccessToken({ prompt: "none" }); } catch {}
    }
  }, [clientId]);

  const loadGsi = useCallback(() => {
    if (!clientId) return;
    if (gsiLoaded.current) { initTokenClient(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
      gsiLoaded.current = true;
      initTokenClient();
    };
    document.head.appendChild(s);
  }, [clientId, initTokenClient]);

  useEffect(() => { loadGsi(); }, [loadGsi]);

  // Mouse wheel → horizontal scroll on priority feed
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (e.deltaY === 0) return;
      // Only intercept when horizontal scroll is actually possible
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view, data.tasks.length]);

  // Auto-refresh token ~1 minute before expiry
  useEffect(() => {
    if (!token) return;
    const stored = loadStoredToken();
    if (!stored) return;
    const msUntilRefresh = Math.max(0, stored.expiresAt - Date.now() - 60000);
    refreshTimer.current = setTimeout(() => {
      if (tokenClient.current) {
        try { tokenClient.current.requestAccessToken({ prompt: "none" }); } catch {}
      }
    }, msUntilRefresh);
    return () => clearTimeout(refreshTimer.current);
  }, [token]);

  const login = () => tokenClient.current?.requestAccessToken();
  const logout = () => {
    setToken(null);
    try {
      localStorage.removeItem(LS_TOKEN);
      localStorage.removeItem(LS_USER_EMAIL);
    } catch {}
  };

  // Export current data as a downloadable JSON file
  const exportJson = () => {
    const payload = JSON.stringify(dataRef.current, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `task-tracker-backup-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Import data from a JSON file — merges with current state (union)
  const importJson = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks)) {
          alert("Invalid JSON: expected { projects: [...], tasks: [...] }");
          return;
        }
        const migrated = { projects: parsed.projects, tasks: migrateTasks(parsed.tasks) };
        const merged = mergeData(dataRef.current, migrated);
        save(merged);
      } catch (e) {
        alert("Failed to parse JSON: " + e.message);
      }
    };
    reader.readAsText(file);
  };

  // Overwrite remote with current local state, no merge.
  // Use this from the device that has the correct data to fix a broken sheet.
  const forcePushToSheets = async () => {
    if (!token || !sheetId) return;
    setSyncStatus("syncing");
    try {
      await writeToSheets(token, sheetId, dataRef.current);
      // Full rewrite — rebuild rowMap deterministically from the order we just wrote
      const projRows = new Map();
      (dataRef.current.projects || []).forEach((p, i) => projRows.set(p.id, i + 2));
      const taskRows = new Map();
      (dataRef.current.tasks || []).forEach((t, i) => taskRows.set(t.id, i + 2));
      const noteRows = new Map();
      (dataRef.current.notes || []).forEach((n, i) => noteRows.set(n.id, i + 2));
      rowMapRef.current = { projects: projRows, tasks: taskRows, notes: noteRows };
      prevSyncedRef.current = dataRef.current;
      syncedOnceRef.current = true;
      try { localStorage.setItem(LS_LAST_SYNC, String(Date.now())); } catch {}
      setSyncStatus("ok");
    } catch {
      setSyncStatus("error");
    }
  };

  const syncFromSheets = async () => {
    if (!token || !sheetId) return;
    setSyncStatus("syncing");
    try {
      const remote = await readFromSheets(token, sheetId);
      // Freshly-pulled rowMaps are the source of truth
      rowMapRef.current = remote.rowMaps;
      const remoteData = {
        projects: remote.projects,
        tasks: remote.tasks,
        notes: remote.notes || [],
      };
      const merged = mergeData(dataRef.current, remoteData);
      setData(merged);
      try { localStorage.setItem(LS_KEY, JSON.stringify(merged)); } catch {}
      // Push only the diff between pulled remote and merged state
      await diffPushToSheets(token, sheetId, remoteData, merged, rowMapRef.current);
      prevSyncedRef.current = merged;
      syncedOnceRef.current = true;
      try { localStorage.setItem(LS_LAST_SYNC, String(Date.now())); } catch {}
      setSyncStatus("ok");
    } catch (e) {
      console.error("syncFromSheets failed", e);
      setSyncStatus("error");
    }
  };
  syncFromSheetsRef.current = syncFromSheets;

  const createSheet = async () => {
    if (!token) return;
    setSyncStatus("syncing");
    try {
      const sid = await createSpreadsheet(token);
      setSheetId(sid);
      localStorage.setItem(LS_GSHEET, sid);
      await writeToSheets(token, sid, data);
      setSyncStatus("ok");
    } catch {
      setSyncStatus("error");
    }
  };

  useEffect(() => {
    if (token && sheetId) syncFromSheets();
  }, [token, sheetId]);

  const saveSetup = () => {
    localStorage.setItem(LS_CLIENT, clientId);
    if (sheetId) localStorage.setItem(LS_GSHEET, sheetId);
    setShowSetup(false);
    if (clientId && !gsiLoaded.current) loadGsi();
  };

  // ── DnD sensors ──────────────────────────────────────────────────────────
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } });
  const sensors = useSensors(pointerSensor, touchSensor);

  // ── Project CRUD ─────────────────────────────────────────────────────────
  const addProject = () => { setModal("addProject"); setModalValue(""); };
  const confirmAddProject = () => {
    if (!modalValue.trim()) return;
    const t = now();
    const p = { id: uid(), name: modalValue.trim(), createdAt: t, updatedAt: t };
    save({ ...data, projects: [...data.projects, p] });
    setModal(null);
  };
  const requestDeleteProject = (pid) => setConfirmDeleteId(pid);
  const confirmDeleteProject = () => {
    if (!confirmDeleteId) return;
    save({
      projects: data.projects.filter((p) => p.id !== confirmDeleteId),
      tasks: data.tasks.filter((t) => t.projectId !== confirmDeleteId),
    });
    setConfirmDeleteId(null);
  };
  const openProject = (pid) => { setActiveProjectId(pid); setView("board"); };

  // ── Task CRUD ────────────────────────────────────────────────────────────
  const addTask = (columnId, parentTask = null) => {
    setModal("addTask");
    setModalValue("");
    setModalDesc("");
    setEditingTask({
      column: columnId,
      priority: "none",
      parentId: parentTask?.id || null,
      projectId: parentTask?.projectId || null,
    });
  };
  const addSubtask = (parentTask) => {
    addTask(parentTask.column, parentTask);
  };
  const confirmAddTask = () => {
    if (!modalValue.trim()) return;
    const t = now();
    const projectId = editingTask.projectId || activeProjectId;
    const parentId = editingTask.parentId || null;
    const siblings = data.tasks.filter(
      (tk) =>
        tk.projectId === projectId &&
        tk.column === editingTask.column &&
        (tk.parentId || null) === parentId
    );
    const maxOrder = siblings.length ? Math.max(...siblings.map((tk) => tk.order)) : 0;
    const task = {
      id: uid(),
      projectId,
      parentId,
      title: modalValue.trim(),
      description: modalDesc.trim(),
      column: editingTask.column,
      priority: editingTask.priority || "none",
      order: maxOrder + 1,
      createdAt: t,
      updatedAt: t,
    };
    save({ ...data, tasks: [...data.tasks, task] });
    setModal(null);
    setEditingTask(null);
  };
  const editTask = (task) => {
    setModal("editTask");
    setModalValue(task.title);
    setModalDesc(task.description || "");
    setEditingTask({ ...task, priority: task.priority || "none" });
    setEditPreview(false);
  };
  const viewTask = (task) => setViewingTaskId(task.id);
  const viewingTask = viewingTaskId ? data.tasks.find((t) => t.id === viewingTaskId) : null;

  // Collect a task and all its descendants (for cascade delete)
  const collectDescendants = (tid, tasks) => {
    const ids = new Set([tid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks) {
        if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
          ids.add(t.id);
          changed = true;
        }
      }
    }
    return ids;
  };
  // Quick toggle a child's column between todo and done (from parent view)
  const toggleTaskDone = (tid) => {
    const target = data.tasks.find((t) => t.id === tid);
    if (!target) return;
    const newCol = target.column === "done" ? "todo" : "done";
    save({
      ...data,
      tasks: data.tasks.map((t) =>
        t.id === tid ? { ...t, column: newCol, updatedAt: now() } : t
      ),
    });
  };
  const confirmEditTask = () => {
    if (!modalValue.trim()) return;
    const originalTask = data.tasks.find((t) => t.id === editingTask.id);
    const columnChanged = originalTask && originalTask.column !== editingTask.column;

    let newOrder = originalTask ? originalTask.order : 0;
    if (columnChanged) {
      const targetColTasks = data.tasks.filter(
        (t) => t.projectId === activeProjectId && t.column === editingTask.column && t.id !== editingTask.id
      );
      newOrder = targetColTasks.length ? Math.max(...targetColTasks.map((t) => t.order)) + 1 : 0;
    }

    save({
      ...data,
      tasks: data.tasks.map((t) =>
        t.id === editingTask.id
          ? {
              ...t,
              title: modalValue.trim(),
              description: modalDesc.trim(),
              column: editingTask.column,
              priority: editingTask.priority || "none",
              parentId: editingTask.parentId || null,
              order: newOrder,
              updatedAt: now(),
            }
          : t
      ),
    });
    setModal(null);
    setEditingTask(null);
  };
  const deleteTask = (tid) => {
    const idsToDelete = collectDescendants(tid, data.tasks);
    save({ ...data, tasks: data.tasks.filter((t) => !idsToDelete.has(t.id)) });
    if (viewingTaskId && idsToDelete.has(viewingTaskId)) {
      setViewingTaskId(null);
    }
  };

  // ── Drag handlers ────────────────────────────────────────────────────────
  const findColumn = (id) => {
    const task = data.tasks.find((t) => t.id === id);
    if (task) return task.column;
    if (typeof id === "string" && id.startsWith("column:")) return id.replace("column:", "");
    return null;
  };

  const handleDragStart = (event) => setActiveId(event.active.id);

  const handleDragOver = (event) => {
    const { active, over } = event;
    if (!over) return;

    const activeCol = findColumn(active.id);
    const overCol = findColumn(over.id);
    if (!activeCol || !overCol || activeCol === overCol) return;

    setData((prev) => {
      const updated = prev.tasks.map((t) => {
        if (t.id === active.id) {
          const colTasks = prev.tasks.filter(
            (tk) => tk.projectId === activeProjectId && tk.column === overCol && tk.id !== active.id
          );
          const maxOrder = colTasks.length ? Math.max(...colTasks.map((tk) => tk.order)) : 0;
          return { ...t, column: overCol, order: maxOrder + 1, updatedAt: now() };
        }
        return t;
      });
      return { ...prev, tasks: updated };
    });
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const activeCol = findColumn(active.id);
    const overCol = findColumn(over.id);
    if (!activeCol || !overCol) return;

    if (active.id !== over.id && activeCol === overCol) {
      const colTasks = data.tasks
        .filter((t) => t.projectId === activeProjectId && t.column === activeCol)
        .sort((a, b) => {
          const pa = PRIORITY_RANK[a.priority || "none"] ?? 2;
          const pb = PRIORITY_RANK[b.priority || "none"] ?? 2;
          if (pa !== pb) return pa - pb;
          return a.order - b.order;
        });
      const oldIdx = colTasks.findIndex((t) => t.id === active.id);
      const newIdx = colTasks.findIndex((t) => t.id === over.id);
      if (oldIdx === -1 || newIdx === -1) return;
      const reordered = arrayMove(colTasks, oldIdx, newIdx);
      const orderMap = {};
      reordered.forEach((t, i) => { orderMap[t.id] = i; });
      const next = {
        ...data,
        tasks: data.tasks.map((t) =>
          orderMap[t.id] !== undefined ? { ...t, order: orderMap[t.id], updatedAt: now() } : t
        ),
      };
      save(next);
    } else {
      save({ ...data });
    }
  };

  // ── Derived data ─────────────────────────────────────────────────────────
  const activeProject = data.projects.find((p) => p.id === activeProjectId);
  const projectTasks = data.tasks.filter((t) => t.projectId === activeProjectId);
  // Only top-level tasks appear on the kanban board
  const topLevelProjectTasks = projectTasks.filter((t) => !hasParent(t));
  const tasksByColumn = {};
  COLUMNS.forEach((c) => {
    tasksByColumn[c.id] = topLevelProjectTasks
      .filter((t) => t.column === c.id)
      .sort((a, b) => {
        const pa = PRIORITY_RANK[a.priority || "none"] ?? 2;
        const pb = PRIORITY_RANK[b.priority || "none"] ?? 2;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      });
  });
  // Helper: direct children of a task, sorted by priority then order
  const getChildren = (tid) =>
    data.tasks
      .filter((t) => hasParent(t) && String(t.parentId).trim() === tid)
      .sort((a, b) => {
        const pa = PRIORITY_RANK[a.priority || "none"] ?? 2;
        const pb = PRIORITY_RANK[b.priority || "none"] ?? 2;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      });
  // Precompute direct-child counts for each task (for card indicators)
  const childStats = {};
  data.tasks.forEach((t) => {
    if (hasParent(t)) {
      const pid = String(t.parentId).trim();
      if (!childStats[pid]) childStats[pid] = { count: 0, done: 0 };
      childStats[pid].count += 1;
      if (t.column === "done") childStats[pid].done += 1;
    }
  });

  // Search inside project: compute set of visible task ids (matches + ancestors).
  // null = no filter (show everything).
  const searchTrimmed = boardSearch.trim().toLowerCase();
  let visibleTaskIds = null;
  if (searchTrimmed && view === "board") {
    const matches = (t) =>
      (t.title || "").toLowerCase().includes(searchTrimmed) ||
      (t.description || "").toLowerCase().includes(searchTrimmed);
    visibleTaskIds = new Set();
    const byId = new Map(projectTasks.map((t) => [t.id, t]));
    for (const t of projectTasks) {
      if (matches(t)) {
        let cur = t;
        while (cur) {
          visibleTaskIds.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : null;
        }
      }
    }
  }
  // Effective expansion: when searching, force-expand every ancestor of a match
  // so matching descendants are reachable without the user clicking anything.
  const effectiveExpandedIds = visibleTaskIds
    ? new Set([...expandedIds, ...visibleTaskIds])
    : expandedIds;

  const draggedTask = activeId ? data.tasks.find((t) => t.id === activeId) : null;
  const deleteProjectName = confirmDeleteId ? data.projects.find((p) => p.id === confirmDeleteId)?.name : "";

  // Priority feed: all active tasks from all projects, sorted by priority
  const priorityFeed = data.tasks
    .filter((t) => t.column !== "done" && t.column !== "cancelled")
    .sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority || "none"] ?? 2;
      const pb = PRIORITY_RANK[b.priority || "none"] ?? 2;
      if (pa !== pb) return pa - pb;
      return (a.updatedAt || "").localeCompare(b.updatedAt || "");
    });

  // Columns to render (all on desktop, selected on mobile)
  const visibleColumns = isMobile ? COLUMNS.filter((c) => c.id === mobileCol) : COLUMNS;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0d0f14;
          color: #e8eaf0;
          min-height: 100vh;
          min-height: 100dvh;
          -webkit-tap-highlight-color: transparent;
          overscroll-behavior: none;
        }
        .app {
          max-width: 1200px; margin: 0 auto; padding: 16px;
          min-height: 100vh; min-height: 100dvh;
          display: flex; flex-direction: column;
        }
        .header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 0; margin-bottom: 16px; border-bottom: 1px solid #1e2028;
          flex-shrink: 0;
        }
        .header h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .back-btn {
          background: none; border: none; color: #6b7280; font-size: 20px;
          cursor: pointer; padding: 4px 8px; border-radius: 6px; line-height: 1;
        }
        .back-btn:hover { color: #e8eaf0; background: #1e2028; }
        .header-right { display: flex; gap: 8px; align-items: center; }
        .status-pills { display: flex; gap: 6px; align-items: center; }
        .sync-dot {
          width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0;
        }
        .sync-idle { background: #6b7280; }
        .sync-syncing { background: #f59e0b; animation: pulse 1s infinite; }
        .sync-ok { background: #22c55e; }
        .sync-error { background: #ef4444; }
        .offline-badge {
          font-size: 11px; padding: 2px 8px; border-radius: 10px;
          background: #78350f; color: #fbbf24; font-weight: 500;
        }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

        button {
          background: #1e2028; color: #e8eaf0; border: 1px solid #2a2d38;
          border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 14px;
          transition: background 0.15s;
        }
        button:hover { background: #2a2d38; }
        button:active { background: #353845; }
        .btn-primary { background: #3b82f6; border-color: #3b82f6; }
        .btn-primary:hover { background: #2563eb; }
        .btn-danger { background: #dc2626; border-color: #dc2626; }
        .btn-danger:hover { background: #b91c1c; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .btn-icon {
          background: none; border: none; padding: 4px 6px; font-size: 14px;
          color: #6b7280; cursor: pointer; border-radius: 4px;
        }
        .btn-icon:hover { color: #e8eaf0; background: #2a2d38; }
        .btn-del:hover { color: #ef4444; }

        /* Projects list */
        .projects-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 12px;
        }
        .project-card {
          background: #161820; border: 1px solid #1e2028; border-radius: 10px;
          padding: 20px; cursor: pointer; transition: border-color 0.15s;
          position: relative;
        }
        .project-card:hover { border-color: #3b82f6; }
        .project-card h3 { font-size: 16px; font-weight: 500; margin-bottom: 8px; padding-right: 28px; }
        .project-card .meta { font-size: 12px; color: #6b7280; }
        .project-card .meta-cols {
          display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap;
        }
        .project-card .meta-col {
          font-size: 11px; padding: 2px 6px; border-radius: 4px;
          background: #1e2028;
        }
        .project-card .delete-btn {
          position: absolute; top: 12px; right: 12px;
        }
        .add-card {
          background: #161820; border: 1px dashed #2a2d38; border-radius: 10px;
          padding: 20px; cursor: pointer; display: flex; align-items: center;
          justify-content: center; min-height: 100px; color: #6b7280;
          font-size: 14px; transition: border-color 0.15s;
        }
        .add-card:hover { border-color: #3b82f6; color: #e8eaf0; }

        /* Priority feed */
        .priority-feed-wrap { margin-bottom: 20px; }
        .priority-feed-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .priority-feed-title {
          font-size: 12px; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.5px; color: #6b7280;
        }
        .priority-feed-nav { display: flex; gap: 4px; }
        .feed-arrow {
          padding: 4px 10px; font-size: 14px; line-height: 1;
        }
        .priority-feed {
          display: flex; gap: 10px; overflow-x: auto; padding: 2px;
          scroll-snap-type: x proximity;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .priority-feed::-webkit-scrollbar { display: none; }
        .feed-card {
          flex: 0 0 220px; background: #161820; border: 1px solid #2a2d38;
          border-left: 3px solid transparent; border-radius: 8px;
          padding: 10px 12px; cursor: pointer; transition: border-color 0.15s;
          scroll-snap-align: start;
          display: flex; flex-direction: column; gap: 4px;
          position: relative;
        }
        .feed-card-copy {
          position: absolute; top: 6px; right: 6px;
          background: transparent; border: none; color: #6b7280;
          padding: 4px 6px; font-size: 13px; line-height: 1;
          cursor: pointer; border-radius: 4px;
          opacity: 0; transition: opacity 0.15s, color 0.15s, background 0.15s;
        }
        .feed-card:hover .feed-card-copy { opacity: 1; }
        .feed-card-copy:hover { color: #e8eaf0; background: #2a2d38; }
        .feed-card.priority-urgent { border-left-color: #ef4444; }
        .feed-card.priority-soon { border-left-color: #f59e0b; }
        .feed-card:hover { border-color: #3b82f6; }
        .feed-card.priority-urgent:hover { border-left-color: #ef4444; }
        .feed-card.priority-soon:hover { border-left-color: #f59e0b; }
        .feed-card-project {
          font-size: 10px; color: #6b7280; text-transform: uppercase;
          letter-spacing: 0.5px; font-weight: 600;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .feed-card-title {
          font-size: 13px; color: #e8eaf0; line-height: 1.3;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .feed-card-meta {
          display: flex; gap: 8px; margin-top: 2px; font-size: 10px;
          font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
        }

        /* Empty state */
        .empty-state {
          text-align: center; padding: 60px 20px; color: #6b7280;
        }
        .empty-state p { font-size: 14px; margin-bottom: 16px; }

        /* Kanban board */
        .board-header {
          display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
        }
        .board-header h2 { font-size: 18px; font-weight: 600; flex: 1; }

        /* Global search — floating popover anchored near trigger */
        .global-search-popover {
          position: fixed; top: 64px; right: 16px; z-index: 150;
          width: 480px; max-width: calc(100vw - 32px);
        }
        .global-search-modal {
          background: #161820; border: 1px solid #2a2d38; border-radius: 10px;
          width: 100%; overflow: hidden;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
          display: flex; flex-direction: column; max-height: 70vh;
        }
        @media (max-width: 640px) {
          .global-search-popover { top: 56px; right: 10px; left: 10px; width: auto; }
        }
        .global-search-input {
          width: 100%; background: transparent; border: none;
          color: #e8eaf0; padding: 12px 16px; font-size: 14px;
          outline: none; border-bottom: 1px solid #2a2d38;
        }
        .global-search-input::placeholder { color: #6b7280; }
        .global-search-results {
          flex: 1; overflow-y: auto; padding: 6px;
        }
        .global-search-empty {
          padding: 24px; text-align: center; color: #6b7280; font-size: 13px;
        }
        .search-result {
          padding: 10px 14px; border-radius: 8px; cursor: pointer;
          transition: background 0.1s;
          border: 1px solid transparent;
        }
        .search-result.active {
          background: #1e2028; border-color: #3b82f6;
        }
        .search-result-head {
          display: flex; gap: 8px; align-items: center; margin-bottom: 4px;
          font-size: 10px; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .search-result-proj { color: #9ca3af; }
        .search-result-col, .search-result-prio { }
        .search-result-kind {
          color: #3b82f6; padding: 1px 6px; border-radius: 4px;
          background: #1e2028;
        }
        .search-result-title {
          font-size: 14px; color: #e8eaf0; line-height: 1.3;
        }
        .search-result-snippet {
          font-size: 12px; color: #9ca3af; margin-top: 4px;
          overflow: hidden; text-overflow: ellipsis;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        }
        .search-match {
          background: rgba(245, 158, 11, 0.25); color: #fbbf24;
          border-radius: 2px; padding: 0 2px;
        }
        .global-search-hints {
          display: flex; gap: 16px; padding: 8px 16px;
          border-top: 1px solid #2a2d38; font-size: 11px; color: #6b7280;
          flex-shrink: 0;
        }
        .global-search-hints kbd {
          background: #1e2028; border: 1px solid #2a2d38; border-radius: 3px;
          padding: 1px 5px; font-family: inherit; font-size: 10px;
          color: #9ca3af;
        }

        /* Project mode tabs (Board / Notes) */
        .project-mode-tabs {
          display: flex; gap: 2px; background: #161820;
          border: 1px solid #2a2d38; border-radius: 8px; padding: 2px;
          flex-shrink: 0;
        }
        .mode-tab {
          padding: 6px 14px; font-size: 12px; font-weight: 600;
          background: transparent; border: none; color: #6b7280;
          border-radius: 6px; cursor: pointer;
          text-transform: uppercase; letter-spacing: 0.5px;
          display: flex; align-items: center; gap: 6px;
        }
        .mode-tab:hover { color: #e8eaf0; }
        .mode-tab.active { background: #1e2028; color: #e8eaf0; }
        .mode-tab-count {
          font-size: 10px; background: #2a2d38; color: #9ca3af;
          padding: 1px 6px; border-radius: 8px; font-weight: 500;
        }

        /* Notes panel (project) */
        .notes-panel {
          flex: 1; min-height: 0; display: flex; gap: 0;
          background: #161820; border: 1px solid #1e2028; border-radius: 10px;
          overflow: hidden; position: relative;
        }
        .notes-list {
          flex-shrink: 0;
          border-right: 1px solid #1e2028;
          padding: 10px; overflow-y: auto;
          display: flex; flex-direction: column; gap: 6px;
          transition: width 0.12s ease, padding 0.12s ease;
        }
        .notes-list-resizer {
          width: 6px; flex-shrink: 0; cursor: col-resize;
          background: transparent; transition: background 0.1s;
          position: relative;
        }
        .notes-list-resizer:hover,
        .notes-list-resizer:active {
          background: #3b82f6;
        }
        .notes-list-resizer::before {
          content: ""; position: absolute; left: 2px; top: 0; bottom: 0;
          width: 1px; background: #2a2d38;
        }
        .notes-list-show-btn {
          position: absolute; top: 10px; left: 10px; z-index: 2;
          background: #1e2028; border: 1px solid #2a2d38;
          color: #9ca3af; padding: 6px 10px; font-size: 16px; line-height: 1;
          border-radius: 6px; cursor: pointer;
        }
        .notes-list-show-btn:hover { color: #e8eaf0; border-color: #3b82f6; }
        .notes-new-btn {
          border: 1px dashed #2a2d38; background: transparent;
          color: #9ca3af; padding: 8px; text-align: center;
          border-radius: 6px; cursor: pointer; font-size: 12px;
          font-weight: 500; transition: all 0.15s;
          flex-shrink: 0;
        }
        .notes-new-btn:hover { border-color: #3b82f6; color: #e8eaf0; background: transparent; }
        .notes-empty { padding: 24px 10px; text-align: center; color: #6b7280; font-size: 12px; }
        .note-list-item {
          padding: 10px 12px; border-radius: 6px; cursor: pointer;
          border: 1px solid transparent; transition: all 0.1s;
        }
        .note-list-item:hover { background: #1e2028; border-color: #2a2d38; }
        .note-list-item.active { background: #1e2028; border-color: #3b82f6; }
        .note-list-title {
          font-size: 13px; font-weight: 500; color: #e8eaf0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .note-list-preview {
          font-size: 11px; color: #6b7280; margin-top: 3px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .note-list-link {
          font-size: 10px; color: #3b82f6; margin-top: 4px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          text-transform: uppercase; letter-spacing: 0.3px; font-weight: 600;
        }
        .notes-content {
          flex: 1; min-width: 0; display: flex; flex-direction: column;
          padding: 14px;
        }
        .notes-panel.collapsed .notes-content { padding-left: 56px; }
        .notes-empty-content {
          flex: 1; display: flex; align-items: center; justify-content: center;
          color: #6b7280; font-size: 13px; text-align: center;
        }
        .note-editor-head {
          display: flex; gap: 8px; align-items: center;
          margin-bottom: 12px; flex-shrink: 0;
        }
        .note-title-input {
          flex: 1; background: transparent; border: none;
          color: #e8eaf0; font-size: 18px; font-weight: 600;
          padding: 4px 0; outline: none; min-width: 0;
        }
        .note-editor-actions { display: flex; gap: 6px; flex-shrink: 0; }
        .note-task-select {
          background: #0d0f14; border: 1px solid #2a2d38;
          color: #e8eaf0; padding: 4px 10px; font-size: 12px;
          border-radius: 6px; cursor: pointer; outline: none;
          max-width: 180px; appearance: none;
          padding-right: 24px;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M3 4.5L6 8l3-3.5'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 8px center;
        }
        .note-body-textarea {
          flex: 1; min-height: 0;
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
          color: #e8eaf0; padding: 12px 14px;
          font-size: 13px; line-height: 1.6; outline: none; resize: none;
          font-family: ui-monospace, Menlo, Consolas, monospace;
        }
        .note-body-preview {
          flex: 1; min-height: 0; max-height: none; margin-top: 0;
        }

        /* Board search toolbar */
        .board-toolbar {
          display: flex; gap: 8px; align-items: center;
          margin-bottom: 12px; flex-shrink: 0;
        }
        .board-search {
          flex: 1; min-width: 0;
          background: #0d0f14; border: 1px solid #2a2d38;
          color: #e8eaf0; padding: 8px 12px; border-radius: 6px;
          font-size: 13px; outline: none; transition: border-color 0.15s;
        }
        .board-search:focus { border-color: #3b82f6; }
        .board-search::placeholder { color: #6b7280; }

        /* Project notes */
        .project-notes {
          flex-shrink: 0; margin-top: 16px; background: #161820;
          border: 1px solid #2a2d38; border-radius: 10px; overflow: hidden;
        }
        .project-notes-head {
          display: flex; align-items: center; gap: 10px;
          padding: 10px 14px; cursor: pointer; user-select: none;
          font-size: 12px; color: #9ca3af; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .project-notes-head:hover { background: #1e2028; }
        .project-notes-arrow {
          font-size: 10px; color: #6b7280; width: 10px;
        }
        .project-notes-label { flex: 1; }
        .project-notes-badge {
          font-size: 10px; color: #6b7280; background: #1e2028;
          padding: 2px 8px; border-radius: 10px; font-weight: 500;
          text-transform: none; letter-spacing: 0;
        }
        .project-notes-textarea {
          width: 100%; min-height: 200px; max-height: 60vh;
          background: #0d0f14; border: none; border-top: 1px solid #2a2d38;
          color: #e8eaf0; padding: 14px 16px;
          font-size: 13px; outline: none; resize: vertical;
          font-family: ui-monospace, Menlo, Consolas, monospace;
        }
        .notes-preview {
          border-radius: 0; border-left: none; border-right: none;
          border-bottom: none; margin-top: 0;
        }

        /* Fullscreen notes overlay */
        .notes-fullscreen {
          position: fixed; inset: 0; z-index: 200;
          background: #0d0f14;
          display: flex; flex-direction: column;
          padding: 16px;
          padding-top: max(16px, env(safe-area-inset-top, 16px));
        }
        .notes-fullscreen-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; margin-bottom: 12px;
          padding-bottom: 12px; border-bottom: 1px solid #1e2028;
          flex-shrink: 0;
        }
        .notes-fullscreen-title {
          display: flex; align-items: center; gap: 12px;
          font-size: 18px; font-weight: 600;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          flex: 1; min-width: 0;
        }
        .notes-fullscreen-kind {
          font-size: 10px; font-weight: 600; color: #3b82f6;
          background: #1e2028; padding: 3px 10px; border-radius: 10px;
          text-transform: uppercase; letter-spacing: 0.5px;
          flex-shrink: 0;
        }
        .notes-fullscreen-actions { display: flex; gap: 6px; flex-shrink: 0; }
        .notes-fullscreen-body {
          flex: 1; min-height: 0; overflow: auto;
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 10px;
          padding: 16px 20px;
        }
        .notes-fullscreen-textarea {
          width: 100%; height: 100%; min-height: 100%;
          background: transparent; border: none;
          color: #e8eaf0; padding: 0;
          font-size: 14px; line-height: 1.6; outline: none; resize: none;
          font-family: ui-monospace, Menlo, Consolas, monospace;
        }
        .notes-fullscreen-body .markdown {
          font-size: 14px; line-height: 1.6;
        }
        .notes-fullscreen-body .markdown h1 { font-size: 22px; }
        .notes-fullscreen-body .markdown h2 { font-size: 19px; }
        .notes-fullscreen-body .markdown h3 { font-size: 16px; }

        /* Mobile column tabs */
        .column-tabs {
          display: none; gap: 4px; margin-bottom: 12px;
          overflow-x: auto; -webkit-overflow-scrolling: touch;
          scrollbar-width: none; flex-shrink: 0;
        }
        .column-tabs::-webkit-scrollbar { display: none; }
        .column-tab {
          padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
          background: #161820; border: 1px solid #2a2d38; color: #6b7280;
          cursor: pointer; white-space: nowrap; transition: all 0.15s;
          display: flex; align-items: center; gap: 6px;
        }
        .column-tab.active {
          color: #e8eaf0; border-color: var(--tab-color);
          background: #1e2028;
        }
        .column-tab .tab-count {
          font-size: 11px; background: #2a2d38; padding: 1px 6px;
          border-radius: 8px; min-width: 18px; text-align: center;
        }

        .board {
          display: flex; gap: 12px; overflow-x: auto; padding-bottom: 16px;
          flex: 1; min-height: 0;
        }
        .column {
          flex: 1; min-width: 240px; max-width: 320px; background: #161820;
          border-radius: 10px; display: flex; flex-direction: column;
        }
        .column-header {
          padding: 12px 14px; border-bottom: 2px solid; display: flex;
          align-items: center; justify-content: space-between; flex-shrink: 0;
        }
        .column-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .column-count {
          background: #1e2028; padding: 2px 8px; border-radius: 10px;
          font-size: 11px; color: #6b7280;
        }
        .column-body {
          flex: 1; padding: 8px; display: flex; flex-direction: column; gap: 6px;
          min-height: 60px; overflow-y: auto;
        }
        .task-card {
          background: #1e2028; border: 1px solid #2a2d38; border-radius: 8px;
          padding: 10px 12px 10px 14px; cursor: grab; position: relative;
          touch-action: none; transition: border-color 0.15s;
          border-left: 3px solid transparent;
        }
        .task-card.priority-urgent { border-left-color: #ef4444; }
        .task-card.priority-soon { border-left-color: #f59e0b; }
        .task-card:hover { border-color: #3b82f6; }
        .task-card.priority-urgent:hover { border-left-color: #ef4444; }
        .task-card.priority-soon:hover { border-left-color: #f59e0b; }
        .task-card:active { cursor: grabbing; }
        .task-card.col-done, .task-card.col-cancelled {
          opacity: 0.55; background: #14161c;
        }
        .task-card.col-done .task-title, .task-card.col-cancelled .task-title {
          color: #9ca3af;
        }
        .task-card.col-done:hover, .task-card.col-cancelled:hover { opacity: 0.9; }
        .task-card.col-cancelled .task-title { text-decoration: line-through; }
        @keyframes task-highlight-pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
            border-color: #2a2d38;
          }
          15% {
            box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.7), 0 0 24px rgba(59, 130, 246, 0.55);
            border-color: #3b82f6;
          }
          80% {
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3), 0 0 18px rgba(59, 130, 246, 0.2);
            border-color: #3b82f6;
          }
          100% {
            box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
            border-color: #2a2d38;
          }
        }
        .task-card.highlighted {
          animation: task-highlight-pulse 2.4s ease-out;
        }
        .task-title { font-size: 14px; font-weight: 400; padding-right: 48px; }
        .task-desc {
          font-size: 12px; color: #6b7280; margin-top: 4px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .task-desc .inline-code {
          background: #14161c; padding: 1px 5px; border-radius: 3px;
          font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px;
          color: #e8eaf0; border: 1px solid #2a2d38;
        }
        .task-badges {
          display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px;
          align-items: center;
        }
        .task-priority-badge {
          font-size: 10px; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .task-subtasks-progress {
          font-size: 11px; color: #6b7280; font-weight: 500;
          display: inline-flex; align-items: center; gap: 4px;
          background: transparent; border: 1px solid #2a2d38;
          padding: 2px 8px; border-radius: 10px;
          cursor: pointer; transition: all 0.1s;
        }
        .task-subtasks-progress:hover { color: #e8eaf0; border-color: #3b82f6; }
        .task-subtasks-progress.all-done { color: #22c55e; border-color: #1e3a27; }
        .task-subtasks-progress .expand-arrow {
          display: inline-block; font-size: 9px; line-height: 1; width: 8px;
        }

        /* Nested child cards in column */
        .task-card-child {
          margin-left: 26px;
          position: relative;
          background: #13151c;
          font-size: 13px;
        }
        .task-card-child .task-title { font-size: 13px; }
        .task-card-child::before {
          content: "";
          position: absolute;
          left: -16px;
          top: 0;
          bottom: 50%;
          width: 13px;
          border-left: 2px solid #3b82f6;
          border-bottom: 2px solid #3b82f6;
          border-bottom-left-radius: 8px;
          pointer-events: none;
          opacity: 0.35;
        }
        .task-card-child::after {
          content: "";
          position: absolute;
          left: -16px;
          top: 50%;
          bottom: -6px;
          width: 2px;
          background: #3b82f6;
          opacity: 0.15;
          pointer-events: none;
        }
        .task-card-child[data-depth="2"] { margin-left: 52px; }
        .task-card-child[data-depth="3"] { margin-left: 78px; }
        .task-card-child[data-depth="4"] { margin-left: 104px; }
        .task-card-child[data-depth="5"] { margin-left: 130px; }

        /* Subtasks in view modal */
        .subtasks-details {
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
          padding: 10px 14px; margin-top: 4px;
        }
        .subtasks-details summary {
          cursor: pointer; list-style: none;
          display: flex; align-items: center; justify-content: space-between;
          font-size: 12px; color: #9ca3af; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.5px;
          user-select: none;
        }
        .subtasks-details summary::-webkit-details-marker { display: none; }
        .subtasks-details summary::before {
          content: "▶"; font-size: 9px; margin-right: 8px;
          transition: transform 0.15s; color: #6b7280;
        }
        .subtasks-details[open] summary::before { transform: rotate(90deg); }
        .subtasks-label { flex: 1; }
        .subtasks-progress-text {
          font-size: 11px; color: #6b7280; font-weight: 500;
          background: #1e2028; padding: 2px 8px; border-radius: 10px;
        }
        .subtasks-list {
          list-style: none; padding: 10px 0 0; margin: 0;
          display: flex; flex-direction: column; gap: 6px;
        }
        .subtask-item label {
          display: flex; align-items: center; gap: 8px;
          cursor: pointer; font-size: 13px; color: #e8eaf0;
        }
        .subtask-item input[type="checkbox"] {
          width: 16px; height: 16px; cursor: pointer; accent-color: #3b82f6;
          flex-shrink: 0;
        }
        .subtask-item.done span { color: #6b7280; text-decoration: line-through; }

        /* Subtasks in edit modal */
        .subtasks-edit {
          margin-top: 10px; padding: 10px 12px;
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
        }
        .subtasks-edit-header {
          display: flex; align-items: center; justify-content: space-between;
          font-size: 12px; color: #9ca3af; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
        }
        .subtasks-edit-list {
          list-style: none; padding: 0; margin: 0 0 8px;
          display: flex; flex-direction: column; gap: 6px;
        }
        .subtask-edit-item {
          display: flex; gap: 8px; align-items: center;
        }
        .subtask-edit-item input[type="checkbox"] {
          width: 16px; height: 16px; cursor: pointer; accent-color: #3b82f6;
          flex-shrink: 0;
        }
        .subtask-edit-input {
          flex: 1; width: auto !important; padding: 6px 10px !important;
          font-size: 13px !important; margin: 0 !important;
        }
        .subtask-edit-item.done .subtask-edit-input {
          color: #6b7280; text-decoration: line-through;
        }
        .subtask-add-row {
          display: flex; gap: 6px;
        }
        .subtask-add-input {
          flex: 1; width: auto !important; padding: 6px 10px !important;
          font-size: 13px !important; margin: 0 !important;
        }

        /* Priority selector in modal */
        .priority-selector {
          display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap;
        }
        .priority-btn {
          flex: 1; min-width: 80px; padding: 8px 10px; font-size: 12px;
          background: #0d0f14; border: 1px solid #2a2d38; color: #9ca3af;
          border-radius: 6px; cursor: pointer; transition: all 0.15s;
          font-weight: 500;
        }
        .priority-btn:hover {
          border-color: var(--priority-color);
          color: var(--priority-color);
        }
        .priority-btn.active {
          background: var(--priority-color);
          border-color: var(--priority-color);
          color: #fff;
        }
        .task-actions {
          position: absolute; top: 8px; right: 8px; display: flex; gap: 2px;
          opacity: 0; transition: opacity 0.15s;
        }
        .task-card:hover .task-actions { opacity: 1; }
        .btn-add-task {
          background: none; border: 1px dashed #2a2d38; color: #6b7280;
          border-radius: 6px; padding: 8px; font-size: 13px; cursor: pointer;
          transition: all 0.15s; text-align: center; margin-top: auto; flex-shrink: 0;
        }
        .btn-add-task:hover { border-color: #3b82f6; color: #e8eaf0; }

        /* Drag overlay */
        .drag-overlay {
          background: #1e2028; border: 1px solid #3b82f6; border-radius: 8px;
          padding: 10px 12px; opacity: 0.9; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        }
        .drag-overlay .task-title { font-size: 14px; padding-right: 0; }

        /* Modal */
        .modal-backdrop {
          position: fixed; inset: 0; background: rgba(0,0,0,0.6);
          display: flex; align-items: center; justify-content: center;
          z-index: 100; padding: 16px;
        }
        .modal {
          background: #161820; border: 1px solid #2a2d38; border-radius: 12px;
          padding: 24px; width: 100%; max-width: 400px;
        }
        .modal h3 { font-size: 16px; margin-bottom: 16px; }
        .modal-wide { max-width: 760px; max-height: 90vh; display: flex; flex-direction: column; }
        .modal-wide h3 { margin-bottom: 0; }
        .modal-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; margin-bottom: 14px;
        }
        .view-title {
          font-size: 16px; flex: 1; word-break: break-word;
        }
        .view-meta {
          display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px;
        }
        .view-chip {
          font-size: 10px; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.5px; padding: 3px 8px; border-radius: 10px;
          border: 1px solid;
        }
        .view-chip-muted { color: #9ca3af; border-color: #2a2d38; }
        .view-actions-group { display: flex; gap: 6px; }

        /* Children list in view modal */
        .children-section {
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
          padding: 10px 14px; margin-top: 10px;
        }
        .children-header {
          display: flex; align-items: center; justify-content: space-between;
          font-size: 12px; color: #9ca3af; font-weight: 600;
          text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
        }
        .children-list {
          list-style: none; padding: 0; margin: 0 0 8px;
          display: flex; flex-direction: column; gap: 2px;
        }
        .child-item {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; border-radius: 6px; cursor: pointer;
          transition: background 0.1s;
          border: 1px solid transparent;
        }
        .child-item:hover { background: #161820; border-color: #2a2d38; }
        .child-item.done { opacity: 0.55; }
        .child-item.done .child-title { text-decoration: line-through; color: #9ca3af; }
        .child-item input[type="checkbox"] {
          width: 16px; height: 16px; cursor: pointer; accent-color: #3b82f6;
          flex-shrink: 0;
        }
        .child-title {
          flex: 1; font-size: 13px; color: #e8eaf0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .child-meta {
          display: flex; align-items: center; gap: 8px; flex-shrink: 0;
          font-size: 10px; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .child-col, .child-prio { white-space: nowrap; }
        .child-count { color: #6b7280; font-weight: 500; }
        .child-chevron { color: #6b7280; font-size: 16px; line-height: 1; }
        .add-subtask-btn {
          width: 100%; background: transparent; border: 1px dashed #2a2d38;
          color: #9ca3af;
        }
        .add-subtask-btn:hover { border-color: #3b82f6; color: #e8eaf0; background: transparent; }
        .textarea-big { min-height: 220px !important; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
        .markdown-preview {
          flex: 1; min-height: 220px; max-height: 60vh; overflow: auto;
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
          padding: 14px 16px; margin-top: 10px;
          position: relative;
        }
        .copy-btn-floating {
          position: absolute; top: 8px; right: 8px; z-index: 1;
          padding: 4px 10px; font-size: 11px;
          background: #14161c; border: 1px solid #2a2d38;
          color: #9ca3af; cursor: pointer; border-radius: 6px;
          transition: all 0.15s;
        }
        .copy-btn-floating:hover { color: #e8eaf0; border-color: #3b82f6; }
        .view-title { cursor: pointer; user-select: text; }

        /* Muted scrollbars for modal content & table */
        .markdown-preview, .markdown table, .column-body, .board {
          scrollbar-width: thin;
          scrollbar-color: #2a2d38 transparent;
        }
        .markdown-preview::-webkit-scrollbar,
        .markdown table::-webkit-scrollbar,
        .column-body::-webkit-scrollbar,
        .board::-webkit-scrollbar { width: 8px; height: 8px; }
        .markdown-preview::-webkit-scrollbar-track,
        .markdown table::-webkit-scrollbar-track,
        .column-body::-webkit-scrollbar-track,
        .board::-webkit-scrollbar-track { background: transparent; }
        .markdown-preview::-webkit-scrollbar-thumb,
        .markdown table::-webkit-scrollbar-thumb,
        .column-body::-webkit-scrollbar-thumb,
        .board::-webkit-scrollbar-thumb {
          background: #2a2d38; border-radius: 4px;
        }
        .markdown-preview::-webkit-scrollbar-thumb:hover,
        .markdown table::-webkit-scrollbar-thumb:hover,
        .column-body::-webkit-scrollbar-thumb:hover,
        .board::-webkit-scrollbar-thumb:hover { background: #3a3d48; }
        .markdown-preview::-webkit-scrollbar-corner,
        .markdown table::-webkit-scrollbar-corner { background: transparent; }
        .markdown-empty {
          padding: 20px; text-align: center; color: #6b7280; font-size: 13px;
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
          margin-top: 10px;
        }
        .markdown { font-size: 13px; line-height: 1.5; color: #e8eaf0; }
        .markdown > *:first-child { margin-top: 0; }
        .markdown > *:last-child { margin-bottom: 0; }
        .markdown p { margin: 0 0 10px; }
        .markdown h1, .markdown h2, .markdown h3, .markdown h4 {
          margin: 14px 0 8px; font-weight: 600;
        }
        .markdown h1 { font-size: 18px; }
        .markdown h2 { font-size: 16px; }
        .markdown h3 { font-size: 14px; }
        .markdown ul, .markdown ol { margin: 0 0 10px 22px; }
        .markdown li { margin: 2px 0; }
        .markdown code {
          background: #1e2028; padding: 2px 6px; border-radius: 4px;
          font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
        }
        .markdown pre {
          background: #1e2028; padding: 10px 12px; border-radius: 6px;
          overflow-x: auto; margin: 0;
          font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
          line-height: 1.5;
        }
        .markdown pre code {
          background: none; padding: 0; font-size: inherit;
          display: block; white-space: pre;
        }
        .markdown .code-block-wrap {
          position: relative; margin: 0 0 10px;
        }
        .markdown .code-block-lang {
          position: absolute; top: 6px; right: 8px;
          font-size: 10px; text-transform: uppercase;
          letter-spacing: 0.5px; font-weight: 600; color: #6b7280;
          background: #14161c; padding: 2px 8px; border-radius: 10px;
          pointer-events: none; user-select: none;
          font-family: inherit;
        }
        .markdown .diagram-block pre {
          background: #12141a; border: 1px dashed #2a2d38;
          padding: 14px 16px; line-height: 1.6;
        }
        .markdown .diagram-block pre code {
          color: #7dd3fc; font-size: 12px;
        }
        .markdown .diagram-block .code-block-lang {
          color: #7dd3fc; background: #12141a; border: 1px dashed #2a2d38;
        }
        /* highlight.js theme tweaks to match app background */
        .markdown pre code.hljs { background: transparent; padding: 0; }
        .markdown a { color: #3b82f6; text-decoration: none; }
        .markdown a:hover { text-decoration: underline; }
        .markdown blockquote {
          border-left: 3px solid #2a2d38; padding-left: 10px; color: #9ca3af;
          margin: 0 0 10px;
        }
        .markdown del { color: #6b7280; }
        .markdown hr { border: none; border-top: 1px solid #2a2d38; margin: 14px 0; }
        .markdown table {
          border-collapse: collapse; margin: 0 0 10px;
          display: block; max-width: 100%; overflow-x: auto;
          font-size: 12px;
        }
        .markdown th, .markdown td {
          border: 1px solid #2a2d38; padding: 5px 10px;
          text-align: left; white-space: nowrap;
        }
        .markdown th { background: #1e2028; font-weight: 600; }
        .markdown tr:nth-child(even) td { background: #14161c; }
        .modal input, .modal textarea, .modal select {
          width: 100%; background: #0d0f14; border: 1px solid #2a2d38;
          border-radius: 6px; padding: 10px 12px; color: #e8eaf0;
          font-size: 14px; font-family: inherit; outline: none;
          transition: border-color 0.15s; appearance: none;
        }
        .modal input:focus, .modal textarea:focus, .modal select:focus { border-color: #3b82f6; }
        .modal textarea { resize: vertical; min-height: 60px; margin-top: 10px; }
        .modal select {
          margin-top: 10px; cursor: pointer;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M3 4.5L6 8l3-3.5'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 12px center;
          padding-right: 32px;
        }
        .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
        .modal-text { font-size: 14px; color: #9ca3af; margin-bottom: 16px; line-height: 1.5; }

        /* Setup */
        .setup-panel {
          background: #161820; border: 1px solid #2a2d38; border-radius: 12px;
          padding: 20px; margin-bottom: 16px; flex-shrink: 0;
        }
        .setup-panel h3 { font-size: 14px; margin-bottom: 12px; }
        .setup-panel input {
          width: 100%; background: #0d0f14; border: 1px solid #2a2d38;
          border-radius: 6px; padding: 8px 10px; color: #e8eaf0;
          font-size: 13px; margin-bottom: 8px; outline: none;
        }
        .setup-panel input:focus { border-color: #3b82f6; }
        .setup-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

        /* Mobile */
        @media (max-width: 640px) {
          .app { padding: 10px; padding-bottom: env(safe-area-inset-bottom, 10px); }
          .column-tabs { display: flex; }
          .board { flex-direction: column; overflow-x: visible; }
          .column { min-width: 100%; max-width: 100%; }
          .task-actions { opacity: 1; }
          .header h1 { font-size: 16px; }
          .projects-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="app">
        {/* Header */}
        <div className="header">
          <h1>
            {view === "board" && (
              <button className="back-btn" onClick={() => setView("projects")} title="Back to projects">
                &larr;
              </button>
            )}
            {view === "projects" ? "Task Tracker" : activeProject?.name || "Board"}
          </h1>
          <div className="header-right">
            <div className="status-pills">
              {!isOnline && <span className="offline-badge">offline</span>}
              <span
                className={`sync-dot sync-${syncStatus}`}
                title={`Sync: ${syncStatus}`}
              />
            </div>
            {token ? (
              <>
                {!sheetId && <button className="btn-sm" onClick={createSheet}>Create Sheet</button>}
                {sheetId && <button className="btn-sm" onClick={syncFromSheets}>Sync</button>}
              </>
            ) : clientId ? (
              <button className="btn-sm" onClick={login}>Login</button>
            ) : null}
            {showSetup && token && (
              <button className="btn-sm" onClick={logout}>Logout</button>
            )}
            <button
              className="btn-sm global-search-trigger"
              onClick={() => {
                if (globalSearchOpen) {
                  setGlobalSearchOpen(false);
                } else {
                  setGlobalSearchOpen(true);
                  setGlobalSearchQuery("");
                  setGlobalSearchIdx(0);
                  setTimeout(() => globalSearchInputRef.current?.focus(), 0);
                }
              }}
              title="Search everything (Ctrl+K)"
            >
              &#128269;
            </button>
            <button className="btn-sm" onClick={() => setShowSetup(!showSetup)}>&#9881;</button>
          </div>
        </div>

        {/* Setup */}
        {showSetup && (
          <div className="setup-panel">
            <h3>Google Sheets Sync</h3>
            <input
              placeholder="Google OAuth Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <input
              placeholder="Spreadsheet ID (leave empty to create new)"
              value={sheetId}
              onChange={(e) => setSheetId(e.target.value)}
            />
            <div className="setup-row">
              <button className="btn-sm btn-primary" onClick={saveSetup}>Save</button>
              <button className="btn-sm" onClick={() => setShowSetup(false)}>Cancel</button>
            </div>
            <div className="setup-row" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #2a2d38", flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Backup</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn-sm" onClick={exportJson}>Export JSON</button>
                <label className="btn-sm" style={{ cursor: "pointer", display: "inline-block" }}>
                  Import JSON
                  <input
                    type="file"
                    accept="application/json"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      importJson(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {token && sheetId && (
                  <button className="btn-sm btn-danger" onClick={forcePushToSheets}>
                    Force push
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Projects view */}
        {view === "projects" && (
          <>
            {data.projects.length === 0 && (
              <div className="empty-state">
                <p>No projects yet. Create your first one.</p>
              </div>
            )}
            {priorityFeed.length > 0 && (
              <div className="priority-feed-wrap">
                <div className="priority-feed-header">
                  <span className="priority-feed-title">Priority feed</span>
                  <div className="priority-feed-nav">
                    <button
                      className="feed-arrow"
                      onClick={() => feedRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
                      title="Scroll left"
                    >&larr;</button>
                    <button
                      className="feed-arrow"
                      onClick={() => feedRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
                      title="Scroll right"
                    >&rarr;</button>
                  </div>
                </div>
                <div className="priority-feed" ref={feedRef}>
                  {priorityFeed.map((t) => {
                    const priorityDef = PRIORITIES.find((p) => p.id === (t.priority || "none"));
                    const projName = data.projects.find((p) => p.id === t.projectId)?.name || "";
                    const colDef = COLUMNS.find((c) => c.id === t.column);
                    return (
                      <div
                        key={t.id}
                        className={`feed-card priority-${t.priority || "none"}`}
                        style={{ "--priority-color": priorityDef.color }}
                        onClick={() => focusTaskInBoard(t)}
                      >
                        <button
                          className="feed-card-copy"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyText(t.title, `feed-${t.id}`);
                          }}
                          title="Copy title"
                        >
                          {copiedTarget === `feed-${t.id}` ? "\u2713" : "\u2398"}
                        </button>
                        <div className="feed-card-project">{projName}</div>
                        <div className="feed-card-title">{t.title}</div>
                        <div className="feed-card-meta">
                          <span className="feed-card-col" style={{ color: colDef?.color }}>
                            {colDef?.label}
                          </span>
                          {t.priority !== "none" && (
                            <span className="feed-card-prio" style={{ color: priorityDef.color }}>
                              {priorityDef.label}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="projects-grid">
              {data.projects.map((p) => {
                const pTasks = data.tasks.filter((t) => t.projectId === p.id);
                const activeTasks = pTasks.filter((t) => t.column !== "done" && t.column !== "cancelled");
                const activeCounts = {};
                COLUMNS.forEach((c) => {
                  if (c.id !== "done" && c.id !== "cancelled") {
                    activeCounts[c.id] = activeTasks.filter((t) => t.column === c.id).length;
                  }
                });
                const prioCounts = {
                  urgent: activeTasks.filter((t) => t.priority === "urgent").length,
                  soon: activeTasks.filter((t) => t.priority === "soon").length,
                };
                return (
                  <div key={p.id} className="project-card" onClick={() => openProject(p.id)}>
                    <h3>{p.name}</h3>
                    <div className="meta">{activeTasks.length} task{activeTasks.length !== 1 ? "s" : ""}</div>
                    {(prioCounts.urgent > 0 || prioCounts.soon > 0) && (
                      <div className="meta-cols">
                        {PRIORITIES.map((pr) =>
                          pr.id !== "none" && prioCounts[pr.id] > 0 ? (
                            <span key={pr.id} className="meta-col" style={{ color: pr.color }}>
                              {pr.label} {prioCounts[pr.id]}
                            </span>
                          ) : null
                        )}
                      </div>
                    )}
                    {activeTasks.length > 0 && (
                      <div className="meta-cols">
                        {COLUMNS.filter((c) => c.id !== "done" && c.id !== "cancelled").map((c) =>
                          activeCounts[c.id] > 0 ? (
                            <span key={c.id} className="meta-col" style={{ color: c.color }}>
                              {c.label} {activeCounts[c.id]}
                            </span>
                          ) : null
                        )}
                      </div>
                    )}
                    <button
                      className="btn-icon btn-del delete-btn"
                      title="Delete project"
                      onClick={(e) => { e.stopPropagation(); requestDeleteProject(p.id); }}
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
              <div className="add-card" onClick={addProject}>+ New project</div>
            </div>
          </>
        )}

        {/* Board view */}
        {view === "board" && (
          <>
            <div className="board-toolbar">
              <div className="project-mode-tabs">
                <button
                  className={`mode-tab${projectMode === "board" ? " active" : ""}`}
                  onClick={() => setProjectMode("board")}
                >
                  Board
                </button>
                <button
                  className={`mode-tab${projectMode === "notes" ? " active" : ""}`}
                  onClick={() => { setProjectMode("notes"); setActiveNoteId(null); }}
                >
                  Notes
                  {activeProjectId && (() => {
                    const n = (data.notes || []).filter((x) => x.projectId === activeProjectId).length;
                    return n > 0 ? <span className="mode-tab-count">{n}</span> : null;
                  })()}
                </button>
              </div>
              {projectMode === "board" && (
                <>
                  <input
                    className="board-search"
                    type="text"
                    placeholder="Search tasks in this project…"
                    value={boardSearch}
                    onChange={(e) => setBoardSearch(e.target.value)}
                  />
                  {boardSearch && (
                    <button
                      className="btn-sm"
                      onClick={() => setBoardSearch("")}
                      title="Clear search"
                    >
                      &times;
                    </button>
                  )}
                </>
              )}
            </div>
            {projectMode === "notes" && activeProject && (
              <div className={`notes-panel${notesListCollapsed ? " collapsed" : ""}`} ref={notesPanelRef}>
                {notesListCollapsed && (
                  <button
                    className="notes-list-show-btn"
                    onClick={() => setNotesListCollapsed(false)}
                    title="Show notes list"
                  >
                    &#9776;
                  </button>
                )}
                <div
                  className="notes-list"
                  style={{
                    width: notesListCollapsed ? 0 : notesListWidth,
                    minWidth: notesListCollapsed ? 0 : 160,
                    padding: notesListCollapsed ? 0 : undefined,
                    borderRight: notesListCollapsed ? "none" : undefined,
                    overflow: notesListCollapsed ? "hidden" : undefined,
                  }}
                >
                  <button
                    className="btn-sm notes-new-btn"
                    onClick={() => {
                      const id = createNote(activeProject.id, null, "Untitled note");
                      setActiveNoteId(id);
                    }}
                  >
                    + New note
                  </button>
                  {(() => {
                    const projNotes = (data.notes || [])
                      .filter((n) => n.projectId === activeProject.id)
                      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
                    if (projNotes.length === 0) {
                      return <div className="notes-empty">No notes yet. Click "+ New note" to create one.</div>;
                    }
                    return projNotes.map((n) => {
                      const linkedTask = n.taskId ? data.tasks.find((t) => t.id === n.taskId) : null;
                      const firstLine = (n.body || "").split("\n").find((l) => l.trim()) || "";
                      return (
                        <div
                          key={n.id}
                          className={`note-list-item${activeNoteId === n.id ? " active" : ""}`}
                          onClick={() => setActiveNoteId(n.id)}
                        >
                          <div className="note-list-title">{n.title || "Untitled"}</div>
                          {firstLine && <div className="note-list-preview">{firstLine}</div>}
                          {linkedTask && (
                            <div className="note-list-link">→ {linkedTask.title}</div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
                {!notesListCollapsed && (
                  <div
                    className="notes-list-resizer"
                    onPointerDown={onNotesResizeStart}
                    onDoubleClick={() => setNotesListCollapsed(true)}
                    title="Drag to resize, double-click to hide"
                  />
                )}
                <div className="notes-content">
                  {activeNote ? (
                    <>
                      <div className="note-editor-head">
                        <input
                          className="note-title-input"
                          value={activeNote.title}
                          onChange={(e) => updateNote(activeNote.id, { title: e.target.value })}
                          placeholder="Note title"
                        />
                        <div className="note-editor-actions">
                          <select
                            className="note-task-select"
                            value={activeNote.taskId || ""}
                            onChange={(e) => updateNote(activeNote.id, { taskId: e.target.value || null })}
                          >
                            <option value="">No linked task</option>
                            {data.tasks
                              .filter((t) => t.projectId === activeProject.id)
                              .sort((a, b) => a.title.localeCompare(b.title))
                              .map((t) => (
                                <option key={t.id} value={t.id}>{t.title}</option>
                              ))}
                          </select>
                          <button
                            className="btn-sm"
                            onClick={() => setNoteEditorPreview(!noteEditorPreview)}
                          >
                            {noteEditorPreview ? "Edit" : "Preview"}
                          </button>
                          <button
                            className="btn-sm btn-danger"
                            onClick={() => {
                              if (confirm("Delete this note?")) {
                                deleteNote(activeNote.id);
                                setActiveNoteId(null);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      {noteEditorPreview ? (
                        <div className="markdown-preview note-body-preview">
                          {activeNote.body ? (
                            <div className="markdown">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[rehypeHighlight]}
                                components={markdownComponents}
                              >
                                {activeNote.body}
                              </ReactMarkdown>
                            </div>
                          ) : (
                            <div className="markdown-empty">No content</div>
                          )}
                        </div>
                      ) : (
                        <textarea
                          className="note-body-textarea"
                          value={activeNote.body}
                          onChange={(e) => updateNote(activeNote.id, { body: e.target.value })}
                          onKeyDown={(e) =>
                            handleTabIndent(e, activeNote.body, (v) =>
                              updateNote(activeNote.id, { body: v })
                            )
                          }
                          placeholder="Note content (markdown, tables, code blocks)…"
                        />
                      )}
                    </>
                  ) : (
                    <div className="notes-empty-content">
                      Select a note on the left or create a new one.
                    </div>
                  )}
                </div>
              </div>
            )}
            {projectMode === "board" && (
            <>
            {/* Mobile column tabs */}
            <div className="column-tabs">
              {COLUMNS.map((col) => (
                <button
                  key={col.id}
                  className={`column-tab${mobileCol === col.id ? " active" : ""}`}
                  style={{ "--tab-color": col.color }}
                  onClick={() => setMobileCol(col.id)}
                >
                  {col.label}
                  <span className="tab-count">{tasksByColumn[col.id]?.length || 0}</span>
                </button>
              ))}
            </div>

            <DndContext
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
            >
              <div className="board">
                {visibleColumns.map((col) => (
                  <Column
                    key={col.id}
                    col={col}
                    tasks={tasksByColumn[col.id]}
                    onEdit={editTask}
                    onDelete={deleteTask}
                    onAdd={addTask}
                    onView={viewTask}
                    childStats={childStats}
                    expandedIds={effectiveExpandedIds}
                    onToggleExpand={toggleExpand}
                    getChildren={getChildren}
                    highlightedTaskId={highlightedTaskId}
                    onCopy={(t) => copyText(t.title, `card-${t.id}`)}
                    copiedTarget={copiedTarget}
                    visibleTaskIds={visibleTaskIds}
                  />
                ))}
              </div>
              <DragOverlay>
                {draggedTask ? (
                  <div className="drag-overlay">
                    <div className="task-title">{draggedTask.title}</div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
            </>
            )}
            {activeProject && projectMode === "board" && (
              <div className={`project-notes${notesExpanded ? " expanded" : ""}`}>
                <div
                  className="project-notes-head"
                  onClick={() => setNotesExpanded(!notesExpanded)}
                >
                  <span className="project-notes-arrow">{notesExpanded ? "▾" : "▸"}</span>
                  <span className="project-notes-label">Project notes</span>
                  {activeProject.notes && (
                    <span className="project-notes-badge">{activeProject.notes.length} chars</span>
                  )}
                  {notesExpanded && (
                    <>
                      <button
                        className="btn-sm"
                        onClick={(e) => { e.stopPropagation(); setNotesPreview(!notesPreview); }}
                      >
                        {notesPreview ? "Edit" : "Preview"}
                      </button>
                      <button
                        className="btn-sm"
                        onClick={(e) => { e.stopPropagation(); setNotesFullscreen(true); }}
                        title="Fullscreen"
                      >
                        &#x26F6;
                      </button>
                    </>
                  )}
                </div>
                {notesExpanded && (
                  notesPreview ? (
                    <div className="markdown-preview notes-preview">
                      {activeProject.notes ? (
                        <div className="markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                            components={markdownComponents}
                          >
                            {activeProject.notes}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div className="markdown-empty">No notes yet</div>
                      )}
                    </div>
                  ) : (
                    <textarea
                      className="project-notes-textarea"
                      placeholder="Project notes (markdown, tables, code blocks)…"
                      value={activeProject.notes || ""}
                      onChange={(e) => updateProjectNotes(activeProject.id, e.target.value)}
                      onKeyDown={(e) =>
                        handleTabIndent(e, activeProject.notes || "", (v) =>
                          updateProjectNotes(activeProject.id, v)
                        )
                      }
                    />
                  )
                )}
              </div>
            )}
          </>
        )}

        {/* Fullscreen Project Notes */}
        {notesFullscreen && activeProject && (
          <div className="notes-fullscreen">
            <div className="notes-fullscreen-head">
              <h3 className="notes-fullscreen-title">
                <span className="notes-fullscreen-kind">Notes</span>
                {activeProject.name}
              </h3>
              <div className="notes-fullscreen-actions">
                <button
                  className="btn-sm"
                  onClick={() => setNotesPreview(!notesPreview)}
                >
                  {notesPreview ? "Edit" : "Preview"}
                </button>
                <button
                  className="btn-sm"
                  onClick={() => setNotesFullscreen(false)}
                  title="Exit fullscreen (Esc)"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="notes-fullscreen-body">
              {notesPreview ? (
                activeProject.notes ? (
                  <div className="markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                      components={markdownComponents}
                    >
                      {activeProject.notes}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="markdown-empty">No notes yet</div>
                )
              ) : (
                <textarea
                  className="notes-fullscreen-textarea"
                  autoFocus
                  placeholder="Project notes (markdown, tables, code blocks)…"
                  value={activeProject.notes || ""}
                  onChange={(e) => updateProjectNotes(activeProject.id, e.target.value)}
                  onKeyDown={(e) =>
                    handleTabIndent(e, activeProject.notes || "", (v) =>
                      updateProjectNotes(activeProject.id, v)
                    )
                  }
                />
              )}
            </div>
          </div>
        )}

        {/* Floating Global Search Popover */}
        {globalSearchOpen && (
          <div className="global-search-popover" onClick={(e) => e.stopPropagation()}>
            <div className="global-search-modal">
              <input
                ref={globalSearchInputRef}
                className="global-search-input"
                autoFocus
                placeholder="Search across all projects, tasks, notes…"
                value={globalSearchQuery}
                onChange={(e) => { setGlobalSearchQuery(e.target.value); setGlobalSearchIdx(0); }}
                onKeyDown={onGlobalSearchKey}
              />
              {globalSearchQuery.trim() && (
                <div className="global-search-results">
                  {globalSearchResults.length === 0 ? (
                    <div className="global-search-empty">No matches</div>
                  ) : (
                    globalSearchResults.map((r, i) => {
                      if (r.kind === "task") {
                        const proj = data.projects.find((p) => p.id === r.task.projectId);
                        const colDef = COLUMNS.find((c) => c.id === r.task.column);
                        const prioDef = PRIORITIES.find((p) => p.id === (r.task.priority || "none"));
                        const snippet = r.descMatch
                          ? extractSnippet(r.task.description || "", globalSearchQuery.trim())
                          : "";
                        return (
                          <div
                            key={`t-${r.task.id}`}
                            className={`search-result${i === globalSearchIdx ? " active" : ""}`}
                            onMouseEnter={() => setGlobalSearchIdx(i)}
                            onClick={() => openSearchResult(r)}
                          >
                            <div className="search-result-head">
                              <span className="search-result-proj">{proj?.name || "—"}</span>
                              <span className="search-result-col" style={{ color: colDef?.color }}>
                                {colDef?.label}
                              </span>
                              {r.task.priority && r.task.priority !== "none" && (
                                <span className="search-result-prio" style={{ color: prioDef.color }}>
                                  {prioDef.label}
                                </span>
                              )}
                            </div>
                            <div className="search-result-title">
                              {highlightMatch(r.task.title, globalSearchQuery.trim())}
                            </div>
                            {snippet && (
                              <div className="search-result-snippet">
                                {highlightMatch(snippet, globalSearchQuery.trim())}
                              </div>
                            )}
                          </div>
                        );
                      }
                      if (r.kind === "project") {
                        const snippet = r.notesMatch
                          ? extractSnippet(r.project.notes || "", globalSearchQuery.trim())
                          : "";
                        return (
                          <div
                            key={`p-${r.project.id}`}
                            className={`search-result search-result-project${i === globalSearchIdx ? " active" : ""}`}
                            onMouseEnter={() => setGlobalSearchIdx(i)}
                            onClick={() => openSearchResult(r)}
                          >
                            <div className="search-result-head">
                              <span className="search-result-kind">Project</span>
                            </div>
                            <div className="search-result-title">
                              {highlightMatch(r.project.name, globalSearchQuery.trim())}
                            </div>
                            {snippet && (
                              <div className="search-result-snippet">
                                {highlightMatch(snippet, globalSearchQuery.trim())}
                              </div>
                            )}
                          </div>
                        );
                      }
                      // note kind
                      const proj = data.projects.find((p) => p.id === r.note.projectId);
                      const linkedTask = r.note.taskId
                        ? data.tasks.find((t) => t.id === r.note.taskId)
                        : null;
                      const snippet = r.bodyMatch
                        ? extractSnippet(r.note.body || "", globalSearchQuery.trim())
                        : "";
                      return (
                        <div
                          key={`n-${r.note.id}`}
                          className={`search-result${i === globalSearchIdx ? " active" : ""}`}
                          onMouseEnter={() => setGlobalSearchIdx(i)}
                          onClick={() => openSearchResult(r)}
                        >
                          <div className="search-result-head">
                            <span className="search-result-kind" style={{ color: "#22c55e" }}>Note</span>
                            <span className="search-result-proj">{proj?.name || "—"}</span>
                            {linkedTask && (
                              <span className="search-result-col" style={{ color: "#9ca3af" }}>
                                → {linkedTask.title}
                              </span>
                            )}
                          </div>
                          <div className="search-result-title">
                            {highlightMatch(r.note.title || "Untitled", globalSearchQuery.trim())}
                          </div>
                          {snippet && (
                            <div className="search-result-snippet">
                              {highlightMatch(snippet, globalSearchQuery.trim())}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
              <div className="global-search-hints">
                <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
                <span><kbd>Enter</kbd> open</span>
                <span><kbd>Esc</kbd> close</span>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Add Project */}
        {modal === "addProject" && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>New project</h3>
              <input
                autoFocus
                placeholder="Project name"
                value={modalValue}
                onChange={(e) => setModalValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmAddProject()}
              />
              <div className="modal-actions">
                <button onClick={() => setModal(null)}>Cancel</button>
                <button className="btn-primary" onClick={confirmAddProject}>Create</button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Add Task */}
        {modal === "addTask" && editingTask && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>New task</h3>
              <input
                autoFocus
                placeholder="Task title"
                value={modalValue}
                onChange={(e) => setModalValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmAddTask()}
              />
              <textarea
                placeholder="Description (optional)"
                value={modalDesc}
                onChange={(e) => setModalDesc(e.target.value)}
              />
              <div className="priority-selector">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`priority-btn${editingTask.priority === p.id ? " active" : ""}`}
                    style={{ "--priority-color": p.color }}
                    onClick={() => setEditingTask({ ...editingTask, priority: p.id })}
                    title={p.hint}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="modal-actions">
                <button onClick={() => setModal(null)}>Cancel</button>
                <button className="btn-primary" onClick={confirmAddTask}>Add</button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Edit Task (with column selector) */}
        {modal === "editTask" && editingTask && (
          <div className="modal-backdrop" onClick={() => setModal(null)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3>Edit task</h3>
                <button
                  className="btn-sm"
                  onClick={() => setEditPreview(!editPreview)}
                  title="Toggle preview"
                >
                  {editPreview ? "Edit" : "Preview"}
                </button>
              </div>
              <input
                placeholder="Task title"
                value={modalValue}
                onChange={(e) => setModalValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && confirmEditTask()}
              />
              {editPreview ? (
                <div className="markdown-preview">
                  {modalDesc ? (
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>{modalDesc}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="markdown-empty">No description</div>
                  )}
                </div>
              ) : (
                <textarea
                  className="textarea-big"
                  placeholder="Description (supports markdown, tables, etc.)"
                  value={modalDesc}
                  onChange={(e) => setModalDesc(e.target.value)}
                  onKeyDown={(e) => handleTabIndent(e, modalDesc, setModalDesc)}
                />
              )}
              <select
                value={editingTask.column}
                onChange={(e) => setEditingTask({ ...editingTask, column: e.target.value })}
              >
                {COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <select
                value={editingTask.parentId || ""}
                onChange={(e) => setEditingTask({ ...editingTask, parentId: e.target.value || null })}
              >
                <option value="">— top-level (no parent)</option>
                {(() => {
                  // Collect all descendants of editingTask to exclude (prevent cycles)
                  const forbidden = new Set([editingTask.id]);
                  let changed = true;
                  while (changed) {
                    changed = false;
                    for (const t of data.tasks) {
                      if (t.parentId && forbidden.has(t.parentId) && !forbidden.has(t.id)) {
                        forbidden.add(t.id);
                        changed = true;
                      }
                    }
                  }
                  return data.tasks
                    .filter((t) => t.projectId === editingTask.projectId && !forbidden.has(t.id))
                    .sort((a, b) => a.title.localeCompare(b.title))
                    .map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ));
                })()}
              </select>
              <div className="priority-selector">
                {PRIORITIES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`priority-btn${editingTask.priority === p.id ? " active" : ""}`}
                    style={{ "--priority-color": p.color }}
                    onClick={() => setEditingTask({ ...editingTask, priority: p.id })}
                    title={p.hint}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="modal-actions">
                <button onClick={() => setModal(null)}>Cancel</button>
                <button className="btn-primary" onClick={confirmEditTask}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: View Task (read-only with markdown + children) */}
        {viewingTask && (() => {
          const children = getChildren(viewingTask.id);
          const childDone = children.filter((c) => c.column === "done").length;
          const parentTask = viewingTask.parentId
            ? data.tasks.find((t) => t.id === viewingTask.parentId)
            : null;
          const parentProject = data.projects.find((p) => p.id === viewingTask.projectId);
          return (
            <div className="modal-backdrop" onClick={() => setViewingTaskId(null)}>
              <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  {parentTask ? (
                    <button
                      className="back-btn"
                      onClick={() => setViewingTaskId(parentTask.id)}
                      title={`Back to ${parentTask.title}`}
                    >&larr;</button>
                  ) : null}
                  <h3
                    className="view-title"
                    onDoubleClick={() => copyText(viewingTask.title, "view-title")}
                    title="Double-click to copy title"
                  >
                    {viewingTask.title}
                  </h3>
                  <div className="view-actions-group">
                    <button
                      className="btn-sm"
                      onClick={() => copyText(viewingTask.title, "view-title")}
                      title="Copy title"
                    >
                      {copiedTarget === "view-title" ? "\u2713 Copied" : "Copy title"}
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() => {
                        const projId = viewingTask.projectId;
                        const id = createNote(projId, viewingTask.id, "Note: " + viewingTask.title);
                        setViewingTaskId(null);
                        setActiveProjectId(projId);
                        setView("board");
                        setProjectMode("notes");
                        setActiveNoteId(id);
                      }}
                      title="Create a note linked to this task"
                    >
                      + Note
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() => {
                        const t = viewingTask;
                        setViewingTaskId(null);
                        editTask(t);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </div>
                <div className="view-meta">
                  {(() => {
                    const col = COLUMNS.find((c) => c.id === viewingTask.column);
                    const prio = PRIORITIES.find((p) => p.id === (viewingTask.priority || "none"));
                    return (
                      <>
                        {parentProject && (
                          <span className="view-chip view-chip-muted">{parentProject.name}</span>
                        )}
                        <span className="view-chip" style={{ color: col?.color, borderColor: col?.color }}>
                          {col?.label}
                        </span>
                        {viewingTask.priority && viewingTask.priority !== "none" && (
                          <span className="view-chip" style={{ color: prio.color, borderColor: prio.color }}>
                            {prio.label}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
                {viewingTask.description && (
                  <div className="markdown-preview">
                    <button
                      className="copy-btn-floating"
                      onClick={() => copyText(viewingTask.description, "view-desc")}
                      title="Copy description"
                    >
                      {copiedTarget === "view-desc" ? "\u2713 Copied" : "Copy"}
                    </button>
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={markdownComponents}>{viewingTask.description}</ReactMarkdown>
                    </div>
                  </div>
                )}
                {(() => {
                  const linkedNotes = (data.notes || []).filter(
                    (n) => n.taskId === viewingTask.id
                  );
                  if (linkedNotes.length === 0) return null;
                  return (
                    <div className="children-section">
                      <div className="children-header">
                        <span className="children-label">Linked notes</span>
                        <span className="subtasks-progress-text">{linkedNotes.length}</span>
                      </div>
                      <ul className="children-list">
                        {linkedNotes.map((n) => {
                          const firstLine = (n.body || "").split("\n").find((l) => l.trim()) || "";
                          return (
                            <li
                              key={n.id}
                              className="child-item"
                              onClick={() => {
                                const projId = viewingTask.projectId;
                                setViewingTaskId(null);
                                setActiveProjectId(projId);
                                setView("board");
                                setProjectMode("notes");
                                setActiveNoteId(n.id);
                              }}
                            >
                              <span className="child-title">{n.title || "Untitled"}</span>
                              <span className="child-meta">
                                {firstLine && (
                                  <span className="child-count" style={{ color: "#9ca3af", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{firstLine}</span>
                                )}
                                <span className="child-chevron">›</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}
                <div className="children-section">
                  <div className="children-header">
                    <span className="children-label">Subtasks</span>
                    {children.length > 0 && (
                      <span className="subtasks-progress-text">{childDone}/{children.length}</span>
                    )}
                  </div>
                  {children.length > 0 && (
                    <ul className="children-list">
                      {children.map((c) => {
                        const cPrio = PRIORITIES.find((p) => p.id === (c.priority || "none"));
                        const cCol = COLUMNS.find((col) => col.id === c.column);
                        const grandChildren = getChildren(c.id);
                        const gDone = grandChildren.filter((g) => g.column === "done").length;
                        return (
                          <li
                            key={c.id}
                            className={`child-item col-${c.column}${c.column === "done" ? " done" : ""}`}
                            onClick={() => setViewingTaskId(c.id)}
                          >
                            <input
                              type="checkbox"
                              checked={c.column === "done"}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleTaskDone(c.id)}
                              title="Toggle done"
                            />
                            <span className="child-title">{c.title}</span>
                            <span className="child-meta">
                              {c.priority && c.priority !== "none" && (
                                <span className="child-prio" style={{ color: cPrio.color }}>{cPrio.label}</span>
                              )}
                              {c.column !== "done" && c.column !== "todo" && (
                                <span className="child-col" style={{ color: cCol?.color }}>{cCol?.label}</span>
                              )}
                              {grandChildren.length > 0 && (
                                <span className="child-count">☑ {gDone}/{grandChildren.length}</span>
                              )}
                              <span className="child-chevron">›</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <button
                    className="btn-sm add-subtask-btn"
                    onClick={() => {
                      const parent = viewingTask;
                      setViewingTaskId(null);
                      addSubtask(parent);
                    }}
                  >
                    + Add subtask
                  </button>
                </div>
                {!viewingTask.description && children.length === 0 && (
                  <div className="markdown-empty">Empty task. Add a description or subtasks.</div>
                )}
                <div className="modal-actions">
                  <button onClick={() => setViewingTaskId(null)}>Close</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Modal: Confirm Delete Project */}
        {confirmDeleteId && (
          <div className="modal-backdrop" onClick={() => setConfirmDeleteId(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Delete project</h3>
              <p className="modal-text">
                Delete <strong>{deleteProjectName}</strong> and all its tasks? This cannot be undone.
              </p>
              <div className="modal-actions">
                <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                <button className="btn-danger" onClick={confirmDeleteProject}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
