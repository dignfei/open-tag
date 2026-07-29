import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, ChevronRight, Folder, FolderOpen, House, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type Machine, useStore } from "../store.tsx";
import { projectPathBreadcrumbs, type ProjectDirectoryEntry } from "./projectDirectoryPickerPaths.ts";

type DirectoryEntry = ProjectDirectoryEntry;

interface DirectoryResponse {
  error?: string;
  code?: string;
  roots?: DirectoryEntry[];
  directories?: DirectoryEntry[];
  projects?: DirectoryEntry[];
  nextCursor?: number | null;
  path?: string | null;
}

interface DirectoryQuery {
  path?: string;
  discover?: boolean;
  cursor?: number;
  limit?: number;
}

interface ProjectDirectoryFieldProps {
  value: string;
  onChange: (value: string) => void;
  machine?: Machine;
  disabled?: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  parentHandlesEscape?: boolean;
}

export function ProjectDirectoryField({ value, onChange, machine, disabled, pickerOpen, onPickerOpenChange, parentHandlesEscape = false }: ProjectDirectoryFieldProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="project-path-field">
        <input value={value} maxLength={4096} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={t("members.projectDirectoryPlaceholder")} />
        <button type="button" className="project-path-browse" disabled={disabled || !machine} onClick={() => onPickerOpenChange(true)} title={t("members.projectDirectoryBrowse")} aria-label={t("members.projectDirectoryBrowse")}>
          <FolderOpen size={18} />
        </button>
      </div>
      {pickerOpen && machine ? createPortal(<ProjectDirectoryPicker machine={machine} closeOnEscape={!parentHandlesEscape} onClose={() => onPickerOpenChange(false)} onSelect={(path) => { onChange(path); onPickerOpenChange(false); }} />, document.body) : null}
    </>
  );
}

function responseErrorKey(response: DirectoryResponse): string | null {
  if (!response?.error && !response?.code) return null;
  if (response.code === "project_roots_not_configured") return "members.projectPickerNoRoots";
  if (response.code === "project_browser_unavailable") return "members.projectPickerUnavailable";
  if (response.code === "project_path_not_shared") return "members.projectPickerPathNotShared";
  return "members.projectPickerError";
}

function ProjectDirectoryPicker({ machine, closeOnEscape, onClose, onSelect }: { machine: Machine; closeOnEscape: boolean; onClose: () => void; onSelect: (path: string) => void }) {
  const { t } = useTranslation();
  const { api, serverId } = useStore();
  const apiRef = useRef(api);
  const [roots, setRoots] = useState<DirectoryEntry[]>([]);
  const [projects, setProjects] = useState<DirectoryEntry[]>([]);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [projectsCursor, setProjectsCursor] = useState<number | null>(null);
  const [directoriesCursor, setDirectoriesCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [projectsErrorKey, setProjectsErrorKey] = useState<string | null>(null);
  const requestId = useRef(0);
  const loadingMoreRef = useRef(false);
  const basePath = `/api/servers/${serverId}/machines/${machine.id}/project-directories`;

  useEffect(() => { apiRef.current = api; }, [api]);
  const getRoots = useCallback(async (): Promise<DirectoryResponse> => apiRef.current("GET", basePath), [basePath]);
  const queryDirectories = useCallback(async (body: DirectoryQuery): Promise<DirectoryResponse> => apiRef.current("POST", `${basePath}/query`, body), [basePath]);

  const loadHome = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setProjectsLoading(true);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setErrorKey(null);
    setProjectsErrorKey(null);
    setProjects([]);
    setProjectsCursor(null);
    setCurrentPath(null);
    setDirectories([]);
    if (machine.status === "offline") {
      setErrorKey("members.projectPickerOffline");
      setLoading(false);
      setProjectsLoading(false);
      return;
    }
    void (async () => {
      try {
        const response = await queryDirectories({ discover: true });
        if (id !== requestId.current) return;
        const responseError = responseErrorKey(response);
        if (responseError) {
          setProjects([]);
          setProjectsCursor(null);
          setProjectsErrorKey(responseError);
          return;
        }
        setProjects(response.projects || []);
        setProjectsCursor(response.nextCursor ?? null);
      } catch {
        if (id === requestId.current) setProjectsErrorKey("members.projectPickerError");
      } finally {
        if (id === requestId.current) setProjectsLoading(false);
      }
    })();
    try {
      const rootResponse = await getRoots();
      if (id !== requestId.current) return;
      const rootError = responseErrorKey(rootResponse);
      if (rootError) {
        setErrorKey(rootError);
        setRoots([]);
        setProjects([]);
        return;
      }
      setRoots(rootResponse.roots || []);
    } catch {
      if (id === requestId.current) setErrorKey("members.projectPickerError");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [getRoots, machine.status, queryDirectories]);

  useEffect(() => {
    loadHome();
    return () => { requestId.current += 1; };
  }, [loadHome, machine.id]);

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeOnEscape, onClose]);

  const openDirectory = async (path: string) => {
    const id = ++requestId.current;
    setCurrentPath(path);
    setDirectories([]);
    setDirectoriesCursor(null);
    setLoading(true);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setErrorKey(null);
    try {
      const response = await queryDirectories({ path });
      if (id !== requestId.current) return;
      const responseError = responseErrorKey(response);
      if (responseError) {
        setErrorKey(responseError);
        return;
      }
      setCurrentPath(response.path || path);
      setDirectories(response.directories || []);
      setDirectoriesCursor(response.nextCursor ?? null);
    } catch {
      if (id === requestId.current) setErrorKey("members.projectPickerError");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  const loadMore = async (kind: "projects" | "directories") => {
    const cursor = kind === "projects" ? projectsCursor : directoriesCursor;
    if (cursor == null || loadingMoreRef.current) return;
    const id = requestId.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    if (kind === "projects") setProjectsErrorKey(null);
    try {
      const body: DirectoryQuery = kind === "projects"
        ? { discover: true, cursor }
        : { path: currentPath || "", cursor };
      const response = await queryDirectories(body);
      if (id !== requestId.current) return;
      const responseError = responseErrorKey(response);
      if (responseError) {
        if (kind === "projects") setProjectsErrorKey(responseError);
        else setErrorKey(responseError);
        return;
      }
      if (kind === "projects") {
        setProjects((items) => [...items, ...(response.projects || [])]);
        setProjectsCursor(response.nextCursor ?? null);
      } else {
        setDirectories((items) => [...items, ...(response.directories || [])]);
        setDirectoriesCursor(response.nextCursor ?? null);
      }
    } catch {
      if (id === requestId.current) {
        if (kind === "projects") setProjectsErrorKey("members.projectPickerError");
        else setErrorKey("members.projectPickerError");
      }
    } finally {
      if (id === requestId.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  const crumbs = currentPath ? projectPathBreadcrumbs(roots, currentPath) : [];
  const parentPath = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
  const goBack = () => { if (parentPath) openDirectory(parentPath); else loadHome(); };
  const refresh = () => { if (currentPath) openDirectory(currentPath); else loadHome(); };

  return (
    <div className="modal-bg project-picker-bg" onClick={onClose}>
      <div className="modal project-picker" role="dialog" aria-modal="true" aria-labelledby="project-picker-title" onClick={(event) => event.stopPropagation()}>
        <div className="project-picker-head">
          <div>
            <h3 id="project-picker-title">{t("members.projectPickerTitle")}</h3>
            <div className="project-picker-machine"><span className={`dot ${machine.status || "offline"}`} /> {machine.name || machine.hostname || machine.id}</div>
          </div>
          <div className="project-picker-tools">
            <button type="button" onClick={refresh} disabled={loading} title={t("members.projectPickerRefresh")} aria-label={t("members.projectPickerRefresh")}><RefreshCw size={17} /></button>
            <button type="button" onClick={onClose} title={t("members.close")} aria-label={t("members.close")} autoFocus><X size={18} /></button>
          </div>
        </div>

        <div className="project-picker-nav">
          <button type="button" className="project-picker-back" onClick={goBack} disabled={!currentPath} title={t("members.projectPickerBack")} aria-label={t("members.projectPickerBack")}><ArrowLeft size={16} /></button>
          <div className="project-picker-crumbs" aria-label={t("members.projectPickerBreadcrumbs")}>
            <button type="button" className={!currentPath ? "current" : ""} onClick={loadHome} aria-label={t("members.projectPickerSharedRoots")}><House size={15} /></button>
            {crumbs.map((crumb, index) => <span key={crumb.path}><ChevronRight size={13} /><button type="button" className={index === crumbs.length - 1 ? "current" : ""} onClick={() => openDirectory(crumb.path)} title={crumb.path}>{crumb.name}</button></span>)}
          </div>
        </div>

        <div className="project-picker-body">
          {loading ? <div className="project-picker-state">{t("members.projectPickerLoading")}</div>
            : errorKey ? <div className="project-picker-state is-error"><p>{t(errorKey)}</p><button type="button" className="project-picker-retry" onClick={refresh}>{t("members.projectPickerRetry")}</button></div>
              : <>
                  {!currentPath && <>
                    <section className="project-picker-section">
                      <h4>{t("members.projectPickerDetected")}</h4>
                      {projectsLoading ? <div className="project-picker-empty">{t("members.projectPickerDetecting")}</div> : <>{projects.length ? <div className="project-picker-list">{projects.map((entry) => <button type="button" key={entry.path} className="project-picker-row" onClick={() => onSelect(entry.path)} title={entry.path}><FolderOpen size={17} /><span><b>{entry.name}</b><small>{entry.path}</small></span><Check size={15} /></button>)}</div> : !projectsErrorKey ? <div className="project-picker-empty">{t("members.projectPickerNoProjects")}</div> : null}{projectsErrorKey ? <div className="project-picker-empty is-error">{t(projectsErrorKey)}</div> : null}</>}
                      {projectsCursor != null && <button type="button" className="project-picker-more" disabled={loadingMore} onClick={() => loadMore("projects")}>{loadingMore ? t("members.projectPickerLoading") : t("members.projectPickerLoadMore")}</button>}
                    </section>
                    <section className="project-picker-section">
                      <h4>{t("members.projectPickerSharedRoots")}</h4>
                      {roots.length ? <div className="project-picker-list">{roots.map((entry) => <button type="button" key={entry.path} className="project-picker-row" onClick={() => openDirectory(entry.path)} title={entry.path}><Folder size={17} /><span><b>{entry.name}</b><small>{entry.path}</small></span><ChevronRight size={15} /></button>)}</div> : <div className="project-picker-empty">{t("members.projectPickerNoRoots")}</div>}
                    </section>
                  </>}
                  {currentPath && <section className="project-picker-section">
                    <h4>{t("members.projectPickerFolders")}</h4>
                    {directories.length ? <div className="project-picker-list">{directories.map((entry) => <button type="button" key={entry.path} className="project-picker-row" onClick={() => openDirectory(entry.path)} title={entry.path}><Folder size={17} /><span><b>{entry.name}</b><small>{entry.path}</small></span><ChevronRight size={15} /></button>)}</div> : <div className="project-picker-empty">{t("members.projectPickerNoFolders")}</div>}
                    {directoriesCursor != null && <button type="button" className="project-picker-more" disabled={loadingMore} onClick={() => loadMore("directories")}>{loadingMore ? t("members.projectPickerLoading") : t("members.projectPickerLoadMore")}</button>}
                  </section>}
                </>}
        </div>

        <div className="project-picker-foot">
          <span title={currentPath || undefined}>{currentPath || t("members.projectPickerChooseFolder")}</span>
          <button type="button" className="ok" disabled={!currentPath || loading || !!errorKey} onClick={() => currentPath && onSelect(currentPath)}><Check size={16} /> {t("members.projectPickerSelectCurrent")}</button>
        </div>
      </div>
    </div>
  );
}
