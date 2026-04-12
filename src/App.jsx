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

// ── Constants ────────────────────────────────────────────────────────────────
const LS_KEY = "task-tracker-v1";
const LS_GSHEET = "task-tracker-gsheet";
const LS_CLIENT = "task-tracker-client-id";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

const COLUMNS = [
  { id: "todo", label: "To Do", color: "#6b7280" },
  { id: "inProgress", label: "In Progress", color: "#3b82f6" },
  { id: "done", label: "Done", color: "#22c55e" },
  { id: "cancelled", label: "Cancelled", color: "#ef4444" },
];

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
const readFromSheets = async (token, sid) => {
  const [projRes, taskRes] = await Promise.all([
    sheetsGet(token, sid, "Projects!A2:D"),
    sheetsGet(token, sid, "Tasks!A2:H"),
  ]);
  const projects = (projRes.values || []).map(([id, name, createdAt, updatedAt]) => ({
    id, name, createdAt, updatedAt,
  }));
  const tasks = (taskRes.values || []).map(([id, projectId, title, column, order, createdAt, updatedAt, description]) => ({
    id, projectId, title, column, order: parseFloat(order), createdAt, updatedAt, description: description || "",
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
    ["id", "projectId", "title", "column", "order", "createdAt", "updatedAt", "description"],
    ...data.tasks.map((t) => [t.id, t.projectId, t.title, t.column, String(t.order), t.createdAt, t.updatedAt, t.description || ""]),
  ]);
};

// ── Sortable Task Card ───────────────────────────────────────────────────────
function SortableTask({ task, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "task", task },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="task-card">
      <div className="task-title">{task.title}</div>
      {task.description && <div className="task-desc">{task.description}</div>}
      <div className="task-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button className="btn-icon" onClick={() => onEdit(task)} title="Edit">&#9998;</button>
        <button className="btn-icon btn-del" onClick={() => onDelete(task.id)} title="Delete">&times;</button>
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

function Column({ col, tasks, onEdit, onDelete, onAdd }) {
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
              <SortableTask key={t.id} task={t} onEdit={onEdit} onDelete={onDelete} />
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
  const [activeId, setActiveId] = useState(null);

  // Mobile & online state
  const isMobile = useMediaQuery("(max-width: 640px)");
  const [mobileCol, setMobileCol] = useState("todo");
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Google sync state
  const [syncStatus, setSyncStatus] = useState("idle");
  const [token, setToken] = useState(null);
  const [clientId, setClientId] = useState(() => localStorage.getItem(LS_CLIENT) || "");
  const [sheetId, setSheetId] = useState(() => localStorage.getItem(LS_GSHEET) || "");
  const [showSetup, setShowSetup] = useState(false);
  const gsiLoaded = useRef(false);
  const tokenClient = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;

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
  const loadGsi = useCallback(() => {
    if (gsiLoaded.current || !clientId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
      gsiLoaded.current = true;
      tokenClient.current = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.access_token) {
            setToken(resp.access_token);
          }
        },
      });
    };
    document.head.appendChild(s);
  }, [clientId]);

  useEffect(() => { loadGsi(); }, [loadGsi]);

  const login = () => tokenClient.current?.requestAccessToken();

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
    setEditingTask({ column: columnId });
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
    setEditingTask({ ...task });
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
          ? { ...t, title: modalValue.trim(), description: modalDesc.trim(), column: editingTask.column, order: newOrder, updatedAt: now() }
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
        .sort((a, b) => a.order - b.order);
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
      .sort((a, b) => a.order - b.order);
  });

  const draggedTask = activeId ? data.tasks.find((t) => t.id === activeId) : null;
  const deleteProjectName = confirmDeleteId ? data.projects.find((p) => p.id === confirmDeleteId)?.name : "";

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
          padding: 10px 12px; cursor: grab; position: relative;
          touch-action: none; transition: border-color 0.15s;
        }
        .task-card:hover { border-color: #3b82f6; }
        .task-card:active { cursor: grabbing; }
        .task-title { font-size: 14px; font-weight: 400; padding-right: 48px; }
        .task-desc {
          font-size: 12px; color: #6b7280; margin-top: 4px;
          white-space: pre-wrap; word-break: break-word;
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
            <div className="projects-grid">
              {data.projects.map((p) => {
                const pTasks = data.tasks.filter((t) => t.projectId === p.id);
                const counts = {};
                COLUMNS.forEach((c) => {
                  counts[c.id] = pTasks.filter((t) => t.column === c.id).length;
                });
                return (
                  <div key={p.id} className="project-card" onClick={() => openProject(p.id)}>
                    <h3>{p.name}</h3>
                    <div className="meta">{pTasks.length} task{pTasks.length !== 1 ? "s" : ""}</div>
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
        {modal === "addTask" && (
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
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>Edit task</h3>
              <input
                autoFocus
                placeholder="Task title"
                value={modalValue}
                onChange={(e) => setModalValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmEditTask()}
              />
              <textarea
                placeholder="Description (optional)"
                value={modalDesc}
                onChange={(e) => setModalDesc(e.target.value)}
              />
              <select
                value={editingTask.column}
                onChange={(e) => setEditingTask({ ...editingTask, column: e.target.value })}
              >
                {COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <div className="modal-actions">
                <button onClick={() => setModal(null)}>Cancel</button>
                <button className="btn-primary" onClick={confirmEditTask}>Save</button>
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
