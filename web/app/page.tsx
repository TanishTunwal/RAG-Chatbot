"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ThreadSummary = {
  thread_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: Array<Record<string, unknown>> | null;
  created_at?: string;
};

type PendingApproval = {
  approval_id: string;
  assistant_message: string;
  tool_calls: Array<Record<string, unknown>>;
  status: string;
  created_at: string;
};

type ThreadDetail = {
  thread: ThreadSummary;
  messages: ChatMessage[];
  document: Record<string, unknown>;
  gmail: {
    connected: boolean;
    email: string;
    auth_pending: Record<string, unknown> | null;
  };
  pending_approval: PendingApproval | null;
};

type AuthUser = {
  id: string;
  name: string;
  email: string;
  picture: string;
};

type StatusKey = "gmail" | "pdf" | "workflow";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

let _authToken: string | null = null;
function getAuthToken() {
  if (!_authToken) _authToken = typeof window !== "undefined" ? window.localStorage.getItem("cove.auth") : null;
  return _authToken;
}

function formatDateLabel(value?: string) {
  if (!value) return "Now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatTime(value?: string) {
  if (!value) return "Now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Now";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function previewToolCall(toolCall: Record<string, unknown>) {
  const name = String(toolCall.name ?? "tool");
  const args = JSON.stringify(toolCall.args ?? {}, null, 2);
  return `${name}\n${args}`;
}

function emailPreview(toolCall: Record<string, unknown>) {
  const args = (toolCall.args ?? {}) as Record<string, string>;
  const name = String(toolCall.name ?? "");
  if (name === "send_email" || name === "reply_to_email") {
    return { to: args.to || "", subject: args.subject || "", body: args.body || "" };
  }
  return null;
}

export default function Page() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [approvalThreadId, setApprovalThreadId] = useState<string | null>(null);
  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; email: string; auth_pending: Record<string, unknown> | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusPopover, setStatusPopover] = useState<StatusKey | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  const [devMode, setDevMode] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const streamRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => `${thread.title} ${thread.thread_id}`.toLowerCase().includes(query));
  }, [searchQuery, threads]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.thread_id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );

  const activeDocument = threadDetail?.document && Object.keys(threadDetail.document).length > 0 ? threadDetail.document : null;
  const activeDocumentName = activeDocument ? String(activeDocument.filename ?? "research.pdf") : "";
  const gmailConnected = gmailStatus?.connected ?? threadDetail?.gmail.connected ?? false;
  const gmailEmail = gmailStatus?.email ?? threadDetail?.gmail.email ?? "";
  const title = threadDetail?.thread.title ?? selectedThread?.title ?? "New Chat";
  const hasApproval = Boolean(approval && approvalThreadId === selectedThreadId);
  const activeChatCount = messages.filter((message) => message.role !== "tool").length;

  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const token = getAuthToken();
    const headers: Record<string, string> = {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> ?? {}),
    };
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `Request failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async function loadThreads(preferredId?: string) {
    if (!authUser) {
      if (preferredId) {
        setSelectedThreadId(preferredId);
        window.localStorage.setItem("cove.threadId", preferredId);
      }
      return;
    }
    const nextThreads = await fetchJson<ThreadSummary[]>("/api/threads");
    setThreads(nextThreads);

    const nextSelection = preferredId ?? selectedThreadId ?? window.localStorage.getItem("cove.threadId") ?? nextThreads[0]?.thread_id ?? null;
    if (nextSelection) {
      setSelectedThreadId(nextSelection);
      window.localStorage.setItem("cove.threadId", nextSelection);
    }
  }

  async function loadThread(threadId: string) {
    const detail = await fetchJson<ThreadDetail>(`/api/threads/${threadId}`);
    setThreadDetail(detail);
    setMessages(detail.messages);
    setApproval(detail.pending_approval);
    setApprovalThreadId(detail.pending_approval ? threadId : null);
    setGmailStatus(detail.gmail);
  }

  async function ensureThread() {
    if (selectedThreadId) return selectedThreadId;
    const created = await fetchJson<{ thread_id: string }>("/api/threads", { method: "POST" });
    setSelectedThreadId(created.thread_id);
    window.localStorage.setItem("cove.threadId", created.thread_id);
    await loadThreads(created.thread_id);
    return created.thread_id;
  }

  useEffect(() => {
    const saved = window.localStorage.getItem("cove.auth");
    if (saved) {
      _authToken = saved;
      fetchJson<{ user: AuthUser }>("/api/auth/me").then((res) => {
        setAuthUser(res.user);
        setAuthLoading(false);
      }).catch(() => {
        window.localStorage.removeItem("cove.auth");
        _authToken = null;
        setAuthLoading(false);
      });
    } else {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    loadThreads().catch((err: Error) => setError(err.message));
  }, [authUser]);

  async function handleGoogleCredential(credential: string) {
    try {
      const res = await fetchJson<{ token: string; user: AuthUser }>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential }),
      });
      _authToken = res.token;
      window.localStorage.setItem("cove.auth", res.token);
      setAuthUser(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }

  function handleSignOut() {
    window.localStorage.removeItem("cove.auth");
    _authToken = null;
    setAuthUser(null);
    setSelectedThreadId(null);
    setThreadDetail(null);
    setMessages([]);
    setThreads([]);
  }

  useEffect(() => {
    if (!selectedThreadId) return;
    loadThread(selectedThreadId).catch((err: Error) => setError(err.message));
  }, [selectedThreadId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, approval, streamingText]);

  useEffect(() => {
    return () => { if (streamRef.current) clearInterval(streamRef.current); };
  }, []);

  function startStreaming(messages: ChatMessage[]) {
    if (streamRef.current) clearInterval(streamRef.current);
    setStreamingMsgId(null);
    setStreamingText("");

    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
    if (!lastAssistant) return;

    const id = lastAssistant.created_at ?? `a-${messages.indexOf(lastAssistant)}`;
    const text = lastAssistant.content;
    if (!text) return;

    setStreamingMsgId(id);

    const words = text.split(" ");
    let idx = 0;
    const speed = Math.max(10, Math.min(40, Math.round(600 / words.length)));
    streamRef.current = setInterval(() => {
      idx++;
      setStreamingText(words.slice(0, idx).join(" "));
      if (idx >= words.length) {
        if (streamRef.current) clearInterval(streamRef.current);
        streamRef.current = null;
        setStreamingMsgId(null);
        setStreamingText("");
      }
    }, speed);
  }

  async function handleCreateThread() {
    setIsCreatingThread(true);
    setError(null);
    try {
      const created = await fetchJson<{ thread_id: string }>("/api/threads", { method: "POST" });
      setSelectedThreadId(created.thread_id);
      window.localStorage.setItem("cove.threadId", created.thread_id);
      await loadThreads(created.thread_id);
      await loadThread(created.thread_id);
      setComposer("");
      setApproval(null);
      setApprovalThreadId(null);
      setSearchQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create chat");
    } finally {
      setIsCreatingThread(false);
    }
  }

  async function handleSendMessage() {
    const content = composer.trim();
    if (!content) return;
    setIsSending(true);
    setError(null);
    try {
      const threadId = await ensureThread();
      const result = await fetchJson<{
        status: string;
        assistant_message?: string;
        approval?: PendingApproval;
        messages: ChatMessage[];
      }>(`/api/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });

      setComposer("");
      setMessages(result.messages);
      startStreaming(result.messages);
      if (result.approval) {
        setApproval(result.approval);
        setApprovalThreadId(threadId);
      } else {
        setApproval(null);
        setApprovalThreadId(null);
      }

      await loadThreads(threadId);
      await loadThread(threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setIsSending(false);
    }
  }

  async function handleApproval(approved: boolean) {
    if (!approvalThreadId || !approval) return;
    setIsSending(true);
    setError(null);
    try {
      const result = await fetchJson<{ status: string; messages: ChatMessage[] }>(`/api/approvals/${approval.approval_id}/respond`, {
        method: "POST",
        body: JSON.stringify({ approved }),
      });
      setMessages(result.messages);
      setApproval(null);
      setApprovalThreadId(null);
      await loadThread(approvalThreadId);
      await loadThreads(approvalThreadId);
      if (approved) {
        startStreaming(result.messages);
      } else {
        setComposer("Please revise the email draft.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval update failed");
    } finally {
      setIsSending(false);
    }
  }

  async function handlePdfUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !selectedThreadId) return;
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await fetchJson(`/api/threads/${selectedThreadId}/pdf`, {
        method: "POST",
        body: formData,
      });
      await loadThread(selectedThreadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      event.target.value = "";
      setIsUploading(false);
      setAttachMenuOpen(false);
    }
  }

  async function clearContext() {
    if (!selectedThreadId) return;
    setError(null);
    try {
      await fetchJson(`/api/threads/${selectedThreadId}/context`, { method: "DELETE" });
      await loadThread(selectedThreadId);
      setDrawerOpen(false);
      setStatusPopover(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear context");
    }
  }

  async function handleDeleteThread(threadId: string) {
    setError(null);
    try {
      await fetchJson(`/api/threads/${threadId}`, { method: "DELETE" });
      if (selectedThreadId === threadId) {
        setSelectedThreadId(null);
        setThreadDetail(null);
        setMessages([]);
        setApproval(null);
        setApprovalThreadId(null);
        window.localStorage.removeItem("cove.threadId");
      }
      await loadThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete chat");
    }
  }

  async function handleGmailConnect() {
    const threadId = await ensureThread();
    setGmailBusy(true);
    setError(null);
    try {
      const result = await fetchJson<{ status: string; auth_url?: string }>(`/api/threads/${threadId}/gmail/start`, { method: "POST" });
      if (result.auth_url) {
        window.open(result.auth_url, "_blank");
      }
      let done = false;
      for (let attempt = 0; attempt < 30 && !done; attempt += 1) {
        const status = await fetchJson<{ connected: boolean; email: string; auth_pending: Record<string, unknown> | null }>(
          `/api/threads/${threadId}/gmail/status`,
        );
        setGmailStatus(status);
        const pendingStatus = status.auth_pending?.status;
        if (status.connected || pendingStatus === "done" || pendingStatus === "error") {
          done = true;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      await loadThread(threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gmail sign-in failed");
    } finally {
      setGmailBusy(false);
      setDrawerOpen(false);
    }
  }

  function openPdfPicker() {
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  }

  const statusDetails: Record<StatusKey, { label: string; description: string }> = {
    gmail: {
      label: gmailConnected ? "Connected" : "Disconnected",
      description: gmailConnected
        ? `Connected as ${gmailEmail || "available"}`
        : "Connect Gmail to send and read emails through the assistant.",
    },
    pdf: {
      label: activeDocument ? "Indexed" : "No PDF",
      description: activeDocument
        ? `Active file: ${activeDocumentName}`
        : "Upload a PDF for the assistant to reference.",
    },
    workflow: {
      label: hasApproval ? "Approval pending" : "Autonomous",
      description: hasApproval
        ? "A Gmail action needs your approval before it runs."
        : "The assistant operates without requiring approval.",
    },
  };

  const drawerSections = [
    {
      title: "Gmail",
      body: authUser ? statusDetails.gmail.description : "Sign in with Google to connect Gmail.",
      label: authUser ? statusDetails.gmail.label : "Requires sign-in",
      render: () =>
        !authUser ? (
          <p className="mt-3 text-sm text-zinc-600">Sign in from the sidebar to access Gmail.</p>
        ) : gmailConnected ? (
          <div className="mt-3 space-y-2 text-sm text-zinc-300">
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Account</span>
              <span>{gmailEmail || "Connected"}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Last sync</span>
              <span>{formatTime(threadDetail?.thread.updated_at)}</span>
            </div>
            <button className="mt-1 text-sm text-teal-400 hover:text-teal-300" onClick={handleGmailConnect}>
              Reconnect
            </button>
          </div>
        ) : (
          <button
            className="mt-3 rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-400 disabled:opacity-50"
            onClick={handleGmailConnect}
            disabled={gmailBusy}
          >
            {gmailBusy ? "Connecting..." : "Connect Gmail"}
          </button>
        ),
    },
    {
      title: "PDF",
      body: authUser ? statusDetails.pdf.description : "Sign in to upload PDFs.",
      label: authUser ? statusDetails.pdf.label : "Requires sign-in",
      render: () =>
        !authUser ? (
          <p className="mt-3 text-sm text-zinc-600">Sign in from the sidebar to upload PDFs.</p>
        ) : activeDocument ? (
          <button className="mt-3 text-sm text-teal-400 hover:text-teal-300" onClick={clearContext}>
            Clear document context
          </button>
        ) : null,
    },
    {
      title: "Workflow",
      body: authUser ? statusDetails.workflow.description : "Sign in to use workflow tools.",
      label: authUser ? statusDetails.workflow.label : "Requires sign-in",
    },
    {
      title: "Settings",
      body: "Minimal interface, dark theme, chat-first layout. All tools stay hidden until requested.",
      label: "UI settings",
      render: () => (
        <label className="mt-3 flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2.5 text-sm hover:bg-zinc-800/70">
          <span className="text-zinc-300">Developer Mode</span>
          <div className="relative h-5 w-9 cursor-pointer">
            <input type="checkbox" className="peer sr-only" checked={devMode} onChange={() => setDevMode((v) => !v)} />
            <div className="absolute inset-0 rounded-full bg-zinc-700 transition peer-checked:bg-teal-500/40" />
            <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-zinc-400 transition peer-checked:translate-x-4 peer-checked:bg-teal-400" />
          </div>
        </label>
      ),
    },
  ];

  if (authLoading) {
    return <div className="flex h-screen items-center justify-center bg-[#0c0c10]"><div className="h-5 w-5 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" /></div>;
  }

  return (
    <div className="flex h-screen bg-[#0c0c10] text-zinc-100">
      {sidebarOpen ? (
        <button className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col border-r border-zinc-800 bg-[#0f0f14] transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <span className="text-base font-semibold tracking-tight text-white">Cove</span>
        </div>

        <div className="px-3">
          <button
            className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            onClick={handleCreateThread}
            disabled={isCreatingThread}
            title="New chat"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
              <path fill="currentColor" d="M11 5h2v14h-2V5Zm-6 6h14v2H5v-2Z" />
            </svg>
            <span>{isCreatingThread ? "Creating..." : "New Chat"}</span>
          </button>
        </div>

        <label className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800/30 px-3 py-2 text-sm text-zinc-500 focus-within:border-zinc-700 hover:bg-zinc-800/50">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
            <path fill="currentColor" d="M10.5 4a6.5 6.5 0 1 0 4.07 11.57l4.43 4.43 1.41-1.41-4.43-4.43A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z" />
          </svg>
          <input type="search" className="w-full bg-transparent outline-none placeholder:text-zinc-600" placeholder="Search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </label>

        <div className="mt-2 flex-1 overflow-y-auto px-2">
          <div className="space-y-0.5">
            {filteredThreads.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-zinc-600">No conversations yet.</div>
            ) : (
              filteredThreads.map((thread) => {
                const selected = thread.thread_id === selectedThreadId;
                return (
                  <div key={thread.thread_id} className={`group flex items-center gap-1 rounded-lg px-3 py-2.5 transition ${selected ? "bg-zinc-800" : "hover:bg-zinc-800/50"}`}>
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        setSelectedThreadId(thread.thread_id);
                        window.localStorage.setItem("cove.threadId", thread.thread_id);
                        setSidebarOpen(false);
                      }}
                    >
                      <div className="truncate text-sm font-medium text-zinc-200">{thread.title}</div>
                      {thread.title !== "New chat" ? <div className="mt-0.5 text-xs text-zinc-600">{formatDateLabel(thread.updated_at)}</div> : null}
                    </button>
                    <button
                      className="shrink-0 rounded-md p-1 text-zinc-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                      onClick={(e) => { e.stopPropagation(); void handleDeleteThread(thread.thread_id); }}
                      title="Delete chat"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
                        <path fill="currentColor" d="M9 3h6v2H9V3ZM4 6h16v2H4V6Zm2 2v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8H6Zm3 3h2v8H9v-8Zm4 0h2v8h-2v-8Z" />
                      </svg>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="border-t border-zinc-800 px-3 py-3">
          {authUser ? (
            <div className="flex items-center gap-3">
              {authUser.picture ? (
                <img src={authUser.picture} alt="" className="h-8 w-8 shrink-0 rounded-full" />
              ) : (
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-400">{authUser.name.charAt(0)}</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-zinc-300">{authUser.name}</div>
                <div className="truncate text-xs text-zinc-600">{authUser.email}</div>
              </div>
              <button className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onClick={handleSignOut} title="Sign out">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                  <path fill="currentColor" d="M16 17v-3H9v-2h7V9l5 4-5 4ZM14 7H5v10h9v2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9v2Z" />
                </svg>
              </button>
            </div>
          ) : GOOGLE_CLIENT_ID ? (
            <GoogleLogin
              onSuccess={(res) => { if (res.credential) void handleGoogleCredential(res.credential); }}
              onError={() => setError("Google sign-in failed")}
              theme="filled_black"
              size="large"
              shape="pill"
              text="signin_with"
            />
          ) : (
            <p className="text-center text-xs text-zinc-600">
              Set <code className="rounded bg-zinc-800 px-1 py-0.5">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> in <code className="rounded bg-zinc-800 px-1 py-0.5">.env.local</code>
            </p>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-2 border-b border-zinc-800 bg-[#0c0c10] px-4 py-2.5 lg:px-6">
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 lg:hidden" onClick={() => setSidebarOpen(true)} title="Open sidebar">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
              <path fill="currentColor" d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
            </svg>
          </button>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            <button
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${statusPopover === "gmail" ? "border-teal-500/30 bg-teal-500/10 text-teal-300" : !authUser ? "border-zinc-800/50 text-zinc-700 cursor-default" : "border-zinc-800 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}
              onClick={() => { if (!authUser) { setError("Sign in to access Gmail."); return; } setStatusPopover(statusPopover === "gmail" ? null : "gmail"); }}
              title={!authUser ? "Sign in to connect Gmail" : gmailConnected ? "Gmail connected" : "Gmail disconnected"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${!authUser ? "bg-zinc-800" : gmailConnected ? "bg-green-500" : "bg-zinc-600"}`} />
              Gmail
            </button>
            <button
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${statusPopover === "pdf" ? "border-teal-500/30 bg-teal-500/10 text-teal-300" : !authUser ? "border-zinc-800/50 text-zinc-700 cursor-default" : "border-zinc-800 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}
              onClick={() => { if (!authUser) { setError("Sign in to upload PDFs."); return; } setStatusPopover(statusPopover === "pdf" ? null : "pdf"); }}
              title={!authUser ? "Sign in to upload PDFs" : activeDocument ? "PDF indexed" : "No PDF"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${!authUser ? "bg-zinc-800" : activeDocument ? "bg-green-500" : "bg-zinc-600"}`} />
              PDF
            </button>
            <button
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${statusPopover === "workflow" ? "border-teal-500/30 bg-teal-500/10 text-teal-300" : !authUser ? "border-zinc-800/50 text-zinc-700 cursor-default" : "border-zinc-800 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`}
              onClick={() => { if (!authUser) { setError("Sign in to use workflow tools."); return; } setStatusPopover(statusPopover === "workflow" ? null : "workflow"); }}
              title={!authUser ? "Sign in to use workflow" : hasApproval ? "Approval pending" : "Autonomous"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${!authUser ? "bg-zinc-800" : hasApproval ? "bg-amber-500" : "bg-zinc-600"}`} />
              Workflow
            </button>
            <button className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onClick={() => setDrawerOpen(true)} title="Settings">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                <path fill="currentColor" d="M19.14 12.94a7.07 7.07 0 0 0 .06-.94c0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.12 7.12 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.3.59.22l2.39-.96c.5.37 1.03.7 1.62.94l.36 2.54c.05.23.26.41.48.41h3.84c.22 0 .43-.18.48-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
              </svg>
            </button>
          </div>
        </header>

        {statusPopover ? (
          <div className="absolute right-6 top-11 z-30 w-72 animate-fade-in">
            <div className="rounded-lg border border-zinc-800 bg-[#15151c] p-4 shadow-xl">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">{statusPopover}</div>
              <div className="mt-1.5 text-sm font-medium text-zinc-100">{statusDetails[statusPopover].label}</div>
              <div className="mt-1 text-sm leading-6 text-zinc-400">{statusDetails[statusPopover].description}</div>
              {statusPopover === "pdf" && activeDocument ? (
                <button className="mt-2 text-xs text-teal-400 hover:text-teal-300" onClick={clearContext}>Clear document context</button>
              ) : null}
              {statusPopover === "gmail" && gmailConnected ? (
                <button className="mt-2 text-xs text-teal-400 hover:text-teal-300" onClick={() => { setDrawerOpen(true); setStatusPopover(null); }}>Open Gmail details</button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 justify-center px-4 lg:px-6">
          <div className="flex w-full max-w-[900px] flex-col">
            <div className="flex-1 overflow-y-auto py-6">
              {title !== "New Chat" && title !== "New chat" ? <h1 className="pb-5 text-xl font-semibold text-zinc-100">{title}</h1> : <div className="pb-5" />}

              {devMode && selectedThreadId ? (
                <div className="-mt-3 mb-5 text-[11px] text-zinc-600">
                  Thread: <span className="font-mono">{selectedThreadId.slice(0, 12)}&hellip;</span> &middot; {messages.length} messages &middot; {activeChatCount} exchanges
                </div>
              ) : null}

              <div className="space-y-4">
                {messages.length === 0 ? (
                  <div className="flex items-center justify-center py-16">
                    <p className="text-sm text-zinc-600">Send a message to get started.</p>
                  </div>
                ) : (
                  messages.filter((m) => m.role !== "tool").map((message, index, arr) => {
                    const lastToolIdx = hasApproval ? arr.map((m) => m.role === "assistant" && !!m.tool_calls?.length).lastIndexOf(true) : -1;
                    const isApprovalTrigger = index === lastToolIdx;
                    const isStreaming = !isApprovalTrigger && streamingMsgId !== null && message.role === "assistant" && (message.created_at ?? `a-${index}`) === streamingMsgId;
                    const displayContent = isStreaming ? streamingText : message.content;

                    if (isApprovalTrigger) {
                      return (
                        <div key={`approval-${approval?.approval_id}`} className="rounded-xl border border-teal-500/15 bg-zinc-800/20 p-5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-teal-400" />
                              <span className="text-[11px] uppercase tracking-wider text-teal-400/80">Approval Needed</span>
                            </div>
                            <span className="text-[11px] text-zinc-600">{formatTime(approval?.created_at)}</span>
                          </div>
                          <p className="mt-2 text-sm text-zinc-300">{approval?.assistant_message}</p>
                          <div className="mt-4 space-y-3">
                            {approval?.tool_calls.map((tc, i) => {
                              const email = emailPreview(tc);
                              if (email) {
                                return (
                                  <div key={`${approval.approval_id}-${i}`} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
                                    <div className="border-b border-zinc-800 bg-zinc-800/30 px-3 py-2">
                                      <span className="text-[11px] uppercase tracking-wider text-zinc-500">Email Draft</span>
                                    </div>
                                    <div className="space-y-2 p-3 text-sm">
                                      <div className="flex gap-2">
                                        <span className="w-14 shrink-0 text-zinc-600">To:</span>
                                        <span className="text-zinc-200">{email.to}</span>
                                      </div>
                                      <div className="flex gap-2">
                                        <span className="w-14 shrink-0 text-zinc-600">Subject:</span>
                                        <span className="text-zinc-200">{email.subject}</span>
                                      </div>
                                      <div className="mt-2 rounded-md bg-zinc-800/30 p-3">
                                        <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">{email.body}</p>
                                      </div>
                                    </div>
                                  </div>
                                );
                              }
                              return (
                                <div key={`${approval.approval_id}-${i}`} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Tool call {i + 1}</p>
                                  <pre className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-200">{previewToolCall(tc)}</pre>
                                </div>
                              );
                            })}
                            <div className="flex gap-2 pt-1">
                              <button className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-white hover:bg-teal-400 disabled:opacity-50" onClick={() => handleApproval(true)} disabled={isSending}>Approve and send</button>
                              <button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50" onClick={() => handleApproval(false)} disabled={isSending}>Revise</button>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                    <div key={`${message.role}-${message.created_at ?? index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[min(680px,100%)] rounded-xl px-4 py-3 text-sm leading-7 ${
                          message.role === "user"
                            ? "bg-teal-500/10 text-zinc-100"
                            : "bg-zinc-800/30 text-zinc-200"
                        }`}
                      >
                        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
                          <span>{message.role === "user" ? "You" : `Assistant${message.tool_calls?.length ? ` · ${message.tool_calls.map((t) => String(t.name ?? "tool")).join(", ")}` : ""}`}</span>
                          {devMode && message.created_at ? <span className="text-zinc-600">{formatTime(message.created_at)}</span> : null}
                        </div>
                        <div className="prose prose-invert prose-sm max-w-none break-words [&_p]:leading-7 [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_strong]:text-zinc-100">{displayContent ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown> : null}{isStreaming ? <span className="inline-block h-4 w-0.5 animate-pulse bg-zinc-400 ml-0.5" /> : null}</div>
                      </div>
                    </div>
                    );
                  })
                )}
                <div ref={messageEndRef} />
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800 bg-[#0c0c10] px-4 py-3 lg:px-6">
          <div className="mx-auto max-w-[900px]">
            {activeDocument || isUploading ? (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-zinc-800/50 px-3 py-1.5 text-xs text-zinc-400">
                {isUploading ? (
                  <>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-teal-400" />
                    <span>Uploading...</span>
                  </>
                ) : (
                  <>
                    <span>&#x1F4C4;</span>
                    <span className="truncate">{activeDocumentName}</span>
                    <button className="ml-auto text-zinc-600 hover:text-zinc-300" onClick={clearContext}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
                        <path fill="currentColor" d="m18.3 5.7-6.3 6.3-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3-1.4-1.4Z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            ) : null}

            <div className="relative rounded-xl border border-zinc-800 bg-[#15151c] p-2">
              {attachMenuOpen ? (
                <div className="absolute bottom-full left-2 mb-2 w-48 rounded-lg border border-zinc-800 bg-[#15151c] p-1 shadow-xl">
                  <button className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800" onClick={openPdfPicker}>
                    <span className="text-base">{"\u{1F4C4}"}</span>
                    <span>Upload PDF</span>
                  </button>
                </div>
              ) : null}

              <div className="flex items-end gap-2">
                <button
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 ${!authUser ? "cursor-not-allowed opacity-30" : "hover:bg-zinc-800 hover:text-zinc-300"}`}
                  onClick={() => { if (!authUser) { setError("Sign in to upload files."); return; } setAttachMenuOpen((v) => !v); }}
                  title={!authUser ? "Sign in to attach files" : "Attach file"}
                  disabled={!authUser}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                    <path fill="currentColor" d="M16.5 6.5 9.07 13.93a3 3 0 1 0 4.24 4.24l7.5-7.5a5 5 0 0 0-7.07-7.07L6.2 11.14a7 7 0 1 0 9.9 9.9l1.06-1.06-1.41-1.41-1.06 1.06a5 5 0 1 1-7.07-7.07l7.53-7.53a3 3 0 1 1 4.24 4.24l-7.5 7.5a1 1 0 1 1-1.41-1.41l7.43-7.43-1.41-1.41Z" />
                  </svg>
                </button>

                <textarea
                  className="min-h-[44px] max-h-36 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
                  placeholder={isSending ? "Waiting for response..." : "Send a message..."}
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  disabled={isSending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                />

                <button
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500 text-white hover:bg-teal-400 disabled:opacity-50"
                  onClick={handleSendMessage}
                  disabled={isSending || !composer.trim()}
                  title="Send"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                    <path fill="currentColor" d="M3.4 20.4 21.65 12 3.4 3.6 3.5 11l10 .99L3.5 13l-.1 7.4Z" />
                  </svg>
                </button>
              </div>

              <input ref={fileInputRef} type="file" className="hidden" accept="application/pdf" onChange={handlePdfUpload} />
            </div>

            <div className="mt-1.5 px-2 text-[11px] text-zinc-600">Enter to send &middot; Shift+Enter for new line</div>
          </div>
        </div>

        {error ? (
          <div className="mx-4 mb-4 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300 lg:mx-6">
            <span className="flex-1">{error}</span>
            <button className="mt-0.5 shrink-0 text-red-400/60 hover:text-red-300" onClick={() => setError(null)}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5">
                <path fill="currentColor" d="m18.3 5.7-6.3 6.3-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3-1.4-1.4Z" />
              </svg>
            </button>
          </div>
        ) : null}
      </main>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50">
          <button className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute right-0 top-0 flex h-full w-full max-w-[360px] flex-col border-l border-zinc-800 bg-[#0f0f14] p-5 shadow-xl animate-slide-in">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-100">Settings</h2>
              <button className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onClick={() => setDrawerOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
                  <path fill="currentColor" d="m18.3 5.7-6.3 6.3-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3-1.4-1.4Z" />
                </svg>
              </button>
            </div>

            <div className="mt-4 flex-1 space-y-2 overflow-y-auto">
              {drawerSections.map((section) => (
                <div key={section.title} className="rounded-lg border border-zinc-800 bg-zinc-800/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] uppercase tracking-wider text-zinc-500">{section.title}</div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-800/50 px-2 py-0.5 text-[11px] text-zinc-400">{section.label}</div>
                  </div>
                  <p className="mt-1.5 text-sm leading-6 text-zinc-400">{section.body}</p>
                  {section.render ? section.render() : null}
                </div>
              ))}
            </div>
          </aside>
        </div>
      ) : null}

    </div>
  );
}
