import { useState, useEffect, useCallback, useRef } from "react";
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

// ── Constants ────────────────────────────────────────────────────────────────
const LS_KEY = "task-tracker-v1";
const LS_GSHEET = "task-tracker-gsheet";
const LS_CLIENT = "task-tracker-client-id";
const LS_TOKEN = "task-tracker-token";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

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
const createSpreadsheet = async (token) => {
  const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: { title: "Task Tracker" },
      sheets: [{ properties: { title: "Projects" } }, { properties: { title: "Tasks" } }],
    }),
  });
  if (!r.ok) throw new Error("Cannot create spreadsheet");
  return (await r.json()).spreadsheetId;
};
const parseSubtasks = (raw) => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const readFromSheets = async (token, sid) => {
  const [projRes, taskRes] = await Promise.all([
    sheetsGet(token, sid, "Projects!A2:D"),
    sheetsGet(token, sid, "Tasks!A2:J"),
  ]);
  const projects = (projRes.values || []).map(([id, name, createdAt, updatedAt]) => ({
    id, name, createdAt, updatedAt,
  }));
  const tasks = (taskRes.values || []).map(([id, projectId, title, column, order, createdAt, updatedAt, description, priority, subtasks]) => ({
    id, projectId, title, column, order: parseFloat(order), createdAt, updatedAt,
    description: description || "",
    priority: priority || "none",
    subtasks: parseSubtasks(subtasks),
  }));
  return { projects, tasks };
};
const writeToSheets = async (token, sid, data) => {
  await sheetsClear(token, sid, "Projects!A1:Z");
  await sheetsClear(token, sid, "Tasks!A1:Z");
  await sheetsUpdate(token, sid, "Projects!A1", [
    ["id", "name", "createdAt", "updatedAt"],
    ...data.projects.map((p) => [p.id, p.name, p.createdAt, p.updatedAt]),
  ]);
  await sheetsUpdate(token, sid, "Tasks!A1", [
    ["id", "projectId", "title", "column", "order", "createdAt", "updatedAt", "description", "priority", "subtasks"],
    ...data.tasks.map((t) => [
      t.id, t.projectId, t.title, t.column, String(t.order), t.createdAt, t.updatedAt,
      t.description || "", t.priority || "none",
      JSON.stringify(t.subtasks || []),
    ]),
  ]);
};

// ── Sortable Task Card ───────────────────────────────────────────────────────
function SortableTask({ task, onEdit, onDelete, onView }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "task", task },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const priority = task.priority || "none";
  const priorityDef = PRIORITIES.find((p) => p.id === priority);
  // First line of description for compact preview
  const descPreview = task.description ? task.description.split("\n").find((l) => l.trim()) || "" : "";
  const hasMoreDesc = task.description && task.description.includes("\n");
  const subtasks = task.subtasks || [];
  const subtasksDone = subtasks.filter((s) => s.done).length;
  return (
    <div
      ref={setNodeRef}
      style={{ ...style, "--priority-color": priorityDef.color }}
      {...attributes}
      {...listeners}
      className={`task-card priority-${priority} col-${task.column}`}
      onClick={() => onView(task)}
    >
      <div className="task-title">{task.title}</div>
      {descPreview && (
        <div className="task-desc">
          {descPreview}{hasMoreDesc && " …"}
        </div>
      )}
      <div className="task-badges">
        {priority !== "none" && (
          <span className="task-priority-badge" style={{ color: priorityDef.color }}>
            {priorityDef.label}
          </span>
        )}
        {subtasks.length > 0 && (
          <span className={`task-subtasks-progress${subtasksDone === subtasks.length ? " all-done" : ""}`}>
            ☑ {subtasksDone}/{subtasks.length}
          </span>
        )}
      </div>
      <div className="task-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn-icon" onClick={(e) => { e.stopPropagation(); onEdit(task); }} title="Edit">&#9998;</button>
        <button className="btn-icon btn-del" onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} title="Delete">&times;</button>
      </div>
    </div>
  );
}

// ── Droppable Column ─────────────────────────────────────────────────────────
function ColumnDropZone({ columnId, children }) {
  const { setNodeRef } = useDroppable({
    id: `column:${columnId}`,
    data: { type: "column", columnId },
  });
  return <div ref={setNodeRef} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minHeight: 60 }}>{children}</div>;
}

function Column({ col, tasks, onEdit, onDelete, onAdd, onView }) {
  const taskIds = tasks.map((t) => t.id);
  return (
    <div className="column">
      <div className="column-header" style={{ borderBottomColor: col.color }}>
        <span className="column-title">{col.label}</span>
        <span className="column-count">{tasks.length}</span>
      </div>
      <div className="column-body">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <ColumnDropZone columnId={col.id}>
            {tasks.map((t) => (
              <SortableTask key={t.id} task={t} onEdit={onEdit} onDelete={onDelete} onView={onView} />
            ))}
          </ColumnDropZone>
        </SortableContext>
        <button className="btn-add-task" onClick={() => onAdd(col.id)}>+ Add task</button>
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState({ projects: [], tasks: [] });
  const [view, setView] = useState("projects"); // "projects" | "board"
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [modal, setModal] = useState(null);
  const [modalValue, setModalValue] = useState("");
  const [modalDesc, setModalDesc] = useState("");
  const [editingTask, setEditingTask] = useState(null);
  const [viewingTask, setViewingTask] = useState(null);
  const [editPreview, setEditPreview] = useState(false);
  const [subtaskInput, setSubtaskInput] = useState("");
  const [activeId, setActiveId] = useState(null);

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

  // Load data from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setData(JSON.parse(raw));
    } catch {}
  }, []);

  // Online/offline detection + auto-sync on reconnect
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (token && sheetId) {
        setSyncStatus("syncing");
        writeToSheets(token, sheetId, dataRef.current)
          .then(() => setSyncStatus("ok"))
          .catch(() => setSyncStatus("error"));
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

  // Save helper
  const save = useCallback(
    (next) => {
      setData(next);
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
      if (token && sheetId) {
        setSyncStatus("syncing");
        writeToSheets(token, sheetId, next)
          .then(() => setSyncStatus("ok"))
          .catch(() => setSyncStatus("error"));
      }
    },
    [token, sheetId]
  );

  // ── Google Auth ──────────────────────────────────────────────────────────
  const initTokenClient = useCallback(() => {
    if (!window.google || !clientId) return;
    tokenClient.current = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.access_token) {
          const expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          setToken(resp.access_token);
          try {
            localStorage.setItem(LS_TOKEN, JSON.stringify({ token: resp.access_token, expiresAt }));
          } catch {}
        }
      },
      error_callback: () => {
        // Silent refresh failed or user dismissed — leave token null
      },
    });
    // Try silent refresh if user previously consented but stored token is gone/expired
    if (!loadStoredToken() && localStorage.getItem(LS_TOKEN)) {
      try { tokenClient.current.requestAccessToken({ prompt: "" }); } catch {}
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
        try { tokenClient.current.requestAccessToken({ prompt: "" }); } catch {}
      }
    }, msUntilRefresh);
    return () => clearTimeout(refreshTimer.current);
  }, [token]);

  const login = () => tokenClient.current?.requestAccessToken();
  const logout = () => {
    setToken(null);
    try { localStorage.removeItem(LS_TOKEN); } catch {}
  };

  const syncFromSheets = async () => {
    if (!token || !sheetId) return;
    setSyncStatus("syncing");
    try {
      const remote = await readFromSheets(token, sheetId);
      if (remote.projects.length || remote.tasks.length) {
        save({ ...remote });
      } else {
        await writeToSheets(token, sheetId, data);
      }
      setSyncStatus("ok");
    } catch {
      setSyncStatus("error");
    }
  };

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
  const addTask = (columnId) => {
    setModal("addTask");
    setModalValue("");
    setModalDesc("");
    setSubtaskInput("");
    setEditingTask({ column: columnId, priority: "none", subtasks: [] });
  };
  const confirmAddTask = () => {
    if (!modalValue.trim()) return;
    const t = now();
    const colTasks = data.tasks.filter(
      (tk) => tk.projectId === activeProjectId && tk.column === editingTask.column
    );
    const maxOrder = colTasks.length ? Math.max(...colTasks.map((tk) => tk.order)) : 0;
    const task = {
      id: uid(),
      projectId: activeProjectId,
      title: modalValue.trim(),
      description: modalDesc.trim(),
      column: editingTask.column,
      priority: editingTask.priority || "none",
      subtasks: editingTask.subtasks || [],
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
    setEditingTask({ ...task, priority: task.priority || "none", subtasks: task.subtasks || [] });
    setSubtaskInput("");
    setEditPreview(false);
  };
  const viewTask = (task) => setViewingTask(task);

  // Subtask helpers
  const addSubtaskEditing = () => {
    const v = subtaskInput.trim();
    if (!v || !editingTask) return;
    setEditingTask({
      ...editingTask,
      subtasks: [...(editingTask.subtasks || []), { id: uid(), title: v, done: false }],
    });
    setSubtaskInput("");
  };
  const updateSubtaskEditing = (sid, patch) => {
    setEditingTask({
      ...editingTask,
      subtasks: (editingTask.subtasks || []).map((s) => (s.id === sid ? { ...s, ...patch } : s)),
    });
  };
  const removeSubtaskEditing = (sid) => {
    setEditingTask({
      ...editingTask,
      subtasks: (editingTask.subtasks || []).filter((s) => s.id !== sid),
    });
  };
  // Toggle subtask on an existing task (from view modal) — persists immediately
  const toggleSubtask = (taskId, subtaskId) => {
    const updatedTasks = data.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            subtasks: (t.subtasks || []).map((s) =>
              s.id === subtaskId ? { ...s, done: !s.done } : s
            ),
            updatedAt: now(),
          }
        : t
    );
    save({ ...data, tasks: updatedTasks });
    if (viewingTask?.id === taskId) {
      const newTask = updatedTasks.find((t) => t.id === taskId);
      if (newTask) setViewingTask(newTask);
    }
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
              subtasks: editingTask.subtasks || [],
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
    save({ ...data, tasks: data.tasks.filter((t) => t.id !== tid) });
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
  const tasksByColumn = {};
  COLUMNS.forEach((c) => {
    tasksByColumn[c.id] = projectTasks
      .filter((t) => t.column === c.id)
      .sort((a, b) => {
        const pa = PRIORITY_RANK[a.priority || "none"] ?? 2;
        const pb = PRIORITY_RANK[b.priority || "none"] ?? 2;
        if (pa !== pb) return pa - pb;
        return a.order - b.order;
      });
  });

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
        }
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
        .task-title { font-size: 14px; font-weight: 400; padding-right: 48px; }
        .task-desc {
          font-size: 12px; color: #6b7280; margin-top: 4px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
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
          display: inline-flex; align-items: center; gap: 3px;
        }
        .task-subtasks-progress.all-done { color: #22c55e; }

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
        .textarea-big { min-height: 220px !important; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
        .markdown-preview {
          flex: 1; min-height: 220px; max-height: 60vh; overflow: auto;
          background: #0d0f14; border: 1px solid #2a2d38; border-radius: 6px;
          padding: 14px 16px; margin-top: 10px;
        }
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
          overflow-x: auto; margin: 0 0 10px;
        }
        .markdown pre code { background: none; padding: 0; }
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
                        onClick={() => openProject(t.projectId)}
                      >
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
                const counts = {};
                COLUMNS.forEach((c) => {
                  counts[c.id] = pTasks.filter((t) => t.column === c.id).length;
                });
                const activeTasks = pTasks.filter((t) => t.column !== "done" && t.column !== "cancelled");
                const prioCounts = {
                  urgent: activeTasks.filter((t) => t.priority === "urgent").length,
                  soon: activeTasks.filter((t) => t.priority === "soon").length,
                };
                return (
                  <div key={p.id} className="project-card" onClick={() => openProject(p.id)}>
                    <h3>{p.name}</h3>
                    <div className="meta">{pTasks.length} task{pTasks.length !== 1 ? "s" : ""}</div>
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
                    {pTasks.length > 0 && (
                      <div className="meta-cols">
                        {COLUMNS.map((c) =>
                          counts[c.id] > 0 ? (
                            <span key={c.id} className="meta-col" style={{ color: c.color }}>
                              {c.label} {counts[c.id]}
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
              <div className="subtasks-edit">
                <div className="subtasks-edit-header">
                  Subtasks
                  {editingTask.subtasks?.length > 0 && (
                    <span className="subtasks-progress-text">
                      {editingTask.subtasks.filter((s) => s.done).length}/{editingTask.subtasks.length}
                    </span>
                  )}
                </div>
                {editingTask.subtasks && editingTask.subtasks.length > 0 && (
                  <ul className="subtasks-edit-list">
                    {editingTask.subtasks.map((s) => (
                      <li key={s.id} className={`subtask-edit-item${s.done ? " done" : ""}`}>
                        <input
                          type="checkbox"
                          checked={!!s.done}
                          onChange={(e) => updateSubtaskEditing(s.id, { done: e.target.checked })}
                        />
                        <input
                          type="text"
                          className="subtask-edit-input"
                          value={s.title}
                          onChange={(e) => updateSubtaskEditing(s.id, { title: e.target.value })}
                        />
                        <button
                          type="button"
                          className="btn-icon btn-del"
                          onClick={() => removeSubtaskEditing(s.id)}
                          title="Remove"
                        >&times;</button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="subtask-add-row">
                  <input
                    type="text"
                    className="subtask-add-input"
                    placeholder="Add subtask…"
                    value={subtaskInput}
                    onChange={(e) => setSubtaskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSubtaskEditing();
                      }
                    }}
                  />
                  <button type="button" className="btn-sm" onClick={addSubtaskEditing}>Add</button>
                </div>
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{modalDesc}</ReactMarkdown>
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
              <div className="subtasks-edit">
                <div className="subtasks-edit-header">
                  Subtasks
                  {editingTask.subtasks?.length > 0 && (
                    <span className="subtasks-progress-text">
                      {editingTask.subtasks.filter((s) => s.done).length}/{editingTask.subtasks.length}
                    </span>
                  )}
                </div>
                {editingTask.subtasks && editingTask.subtasks.length > 0 && (
                  <ul className="subtasks-edit-list">
                    {editingTask.subtasks.map((s) => (
                      <li key={s.id} className={`subtask-edit-item${s.done ? " done" : ""}`}>
                        <input
                          type="checkbox"
                          checked={!!s.done}
                          onChange={(e) => updateSubtaskEditing(s.id, { done: e.target.checked })}
                        />
                        <input
                          type="text"
                          className="subtask-edit-input"
                          value={s.title}
                          onChange={(e) => updateSubtaskEditing(s.id, { title: e.target.value })}
                        />
                        <button
                          type="button"
                          className="btn-icon btn-del"
                          onClick={() => removeSubtaskEditing(s.id)}
                          title="Remove"
                        >&times;</button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="subtask-add-row">
                  <input
                    type="text"
                    className="subtask-add-input"
                    placeholder="Add subtask…"
                    value={subtaskInput}
                    onChange={(e) => setSubtaskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSubtaskEditing();
                      }
                    }}
                  />
                  <button type="button" className="btn-sm" onClick={addSubtaskEditing}>Add</button>
                </div>
              </div>
              <div className="modal-actions">
                <button onClick={() => setModal(null)}>Cancel</button>
                <button className="btn-primary" onClick={confirmEditTask}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: View Task (read-only with markdown) */}
        {viewingTask && (
          <div className="modal-backdrop" onClick={() => setViewingTask(null)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h3 className="view-title">{viewingTask.title}</h3>
                <button
                  className="btn-sm"
                  onClick={() => {
                    const t = viewingTask;
                    setViewingTask(null);
                    editTask(t);
                  }}
                >
                  Edit
                </button>
              </div>
              <div className="view-meta">
                {(() => {
                  const col = COLUMNS.find((c) => c.id === viewingTask.column);
                  const prio = PRIORITIES.find((p) => p.id === (viewingTask.priority || "none"));
                  return (
                    <>
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
              {(viewingTask.subtasks && viewingTask.subtasks.length > 0) && (() => {
                const sts = viewingTask.subtasks;
                const done = sts.filter((s) => s.done).length;
                return (
                  <details className="subtasks-details" open>
                    <summary>
                      <span className="subtasks-label">Subtasks</span>
                      <span className="subtasks-progress-text">{done}/{sts.length}</span>
                    </summary>
                    <ul className="subtasks-list">
                      {sts.map((s) => (
                        <li key={s.id} className={`subtask-item${s.done ? " done" : ""}`}>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!s.done}
                              onChange={() => toggleSubtask(viewingTask.id, s.id)}
                            />
                            <span>{s.title}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })()}
              {viewingTask.description ? (
                <div className="markdown-preview">
                  <div className="markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{viewingTask.description}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                !(viewingTask.subtasks && viewingTask.subtasks.length > 0) && (
                  <div className="markdown-empty">No description</div>
                )
              )}
              <div className="modal-actions">
                <button onClick={() => setViewingTask(null)}>Close</button>
              </div>
            </div>
          </div>
        )}

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
