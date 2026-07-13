from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel

import langgraph_backend as backend


DB_PATH = "chatbot.db"
APP_THREAD_TITLE = "New chat"
SENSITIVE_TOOL_NAMES = {"send_email", "reply_to_email"}
THREAD_AWARE_TOOL_NAMES = {
    "rag_tool",
    "read_emails",
    "search_emails",
    "get_email_content",
    "send_email",
    "reply_to_email",
    "get_attachments_metadata",
    "download_attachment",
}

TOOL_REGISTRY = {tool.name: tool for tool in backend.tools}

app = FastAPI(title="LangGraph Chat API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    content: str


class ApprovalRequest(BaseModel):
    approved: bool


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_tables() -> None:
    conn = _connect()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS chat_threads (
               thread_id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS chat_messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               thread_id TEXT NOT NULL,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               name TEXT,
               tool_call_id TEXT,
               tool_calls_json TEXT,
               created_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS pending_actions (
               approval_id TEXT PRIMARY KEY,
               thread_id TEXT NOT NULL,
               assistant_message TEXT NOT NULL,
               tool_calls_json TEXT NOT NULL,
               status TEXT NOT NULL,
               created_at TEXT NOT NULL,
               resolved_at TEXT,
               resolution_note TEXT
           )"""
    )
    conn.commit()
    conn.close()


def _ensure_thread(thread_id: str, title: str = APP_THREAD_TITLE) -> None:
    _ensure_tables()
    conn = _connect()
    existing = conn.execute(
        "SELECT thread_id FROM chat_threads WHERE thread_id = ?", (thread_id,)
    ).fetchone()
    if existing is None:
        conn.execute(
            """INSERT INTO chat_threads (thread_id, title, created_at, updated_at)
               VALUES (?, ?, ?, ?)""",
            (thread_id, title, _now(), _now()),
        )
        conn.commit()
    conn.close()


def _summarize_chat_title(content: str) -> str:
    normalized = " ".join(content.strip().split())
    if not normalized:
        return APP_THREAD_TITLE

    words = normalized.split()
    if len(words) <= 7:
        return normalized[:48]

    return " ".join(words[:7])[:48]


def create_thread() -> dict:
    thread_id = str(uuid.uuid4())
    _ensure_thread(thread_id)
    return {"thread_id": thread_id}


def _sync_checkpoint_threads() -> None:
    _ensure_tables()
    for thread_id in backend.retrieve_all_threads():
        _ensure_thread(str(thread_id))


def _row_to_thread(row: sqlite3.Row) -> dict:
    return {
        "thread_id": row["thread_id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_threads() -> list[dict]:
    _sync_checkpoint_threads()
    conn = _connect()
    rows = conn.execute(
        "SELECT thread_id, title, created_at, updated_at FROM chat_threads ORDER BY updated_at DESC, created_at DESC"
    ).fetchall()
    conn.close()
    return [_row_to_thread(row) for row in rows]


def _update_thread_touch(thread_id: str) -> None:
    _ensure_thread(thread_id)
    conn = _connect()
    conn.execute(
        "UPDATE chat_threads SET updated_at = ? WHERE thread_id = ?",
        (_now(), thread_id),
    )
    conn.commit()
    conn.close()


def _set_thread_title(thread_id: str, content: str) -> None:
    title = _summarize_chat_title(content)
    conn = _connect()
    conn.execute(
        "UPDATE chat_threads SET title = ?, updated_at = ? WHERE thread_id = ? AND title = ?",
        (title, _now(), thread_id, APP_THREAD_TITLE),
    )
    conn.commit()
    conn.close()


def _append_message(
    thread_id: str,
    role: str,
    content: str,
    *,
    name: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    tool_calls: Optional[list[dict[str, Any]]] = None,
) -> None:
    _ensure_thread(thread_id)
    conn = _connect()
    conn.execute(
        """INSERT INTO chat_messages (thread_id, role, content, name, tool_call_id, tool_calls_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            thread_id,
            role,
            content,
            name,
            tool_call_id,
            json.dumps(tool_calls) if tool_calls else None,
            _now(),
        ),
    )
    conn.execute(
        "UPDATE chat_threads SET updated_at = ? WHERE thread_id = ?",
        (_now(), thread_id),
    )
    conn.commit()
    conn.close()


def _load_checkpoint_history(thread_id: str) -> None:
    conn = _connect()
    count = conn.execute(
        "SELECT COUNT(*) AS total FROM chat_messages WHERE thread_id = ?", (thread_id,)
    ).fetchone()["total"]
    conn.close()
    if count:
        return

    try:
        state = backend.chatbot.get_state(config={"configurable": {"thread_id": thread_id}})
    except Exception:
        return

    messages = state.values.get("messages", []) if getattr(state, "values", None) else []
    for msg in messages:
        content = backend.extract_text(getattr(msg, "content", ""))
        if isinstance(msg, HumanMessage):
            _append_message(thread_id, "user", content)
        elif isinstance(msg, AIMessage):
            tool_calls = getattr(msg, "tool_calls", None) or None
            _append_message(thread_id, "assistant", content, tool_calls=tool_calls)
        elif isinstance(msg, ToolMessage):
            _append_message(
                thread_id,
                "tool",
                content,
                name=getattr(msg, "name", None),
                tool_call_id=getattr(msg, "tool_call_id", None),
            )


def _message_rows(thread_id: str) -> list[dict]:
    _load_checkpoint_history(thread_id)
    conn = _connect()
    rows = conn.execute(
        """SELECT role, content, name, tool_call_id, tool_calls_json, created_at
           FROM chat_messages
           WHERE thread_id = ?
           ORDER BY id ASC""",
        (thread_id,),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def _message_history(thread_id: str) -> list[Any]:
    history: list[Any] = []
    for row in _message_rows(thread_id):
        if row["role"] == "user":
            history.append(HumanMessage(content=row["content"]))
        elif row["role"] == "assistant":
            tool_calls = json.loads(row["tool_calls_json"]) if row["tool_calls_json"] else None
            history.append(AIMessage(content=row["content"], tool_calls=tool_calls or []))
        elif row["role"] == "tool":
            history.append(
                ToolMessage(
                    content=row["content"],
                    name=row["name"] or "tool",
                    tool_call_id=row["tool_call_id"] or "",
                )
            )
    return history


def _system_message(thread_id: str) -> SystemMessage:
    document_note = backend.thread_document_metadata(thread_id)
    doc_text = (
        f"A PDF is already indexed: {document_note.get('filename')}"
        if document_note
        else "No PDF is indexed yet."
    )
    return SystemMessage(
        content=(
            "You are a helpful assistant inside a clean web chat. "
            "You can use search, calculator, PDF RAG, stock, and Gmail tools when useful. "
            "If Gmail send or reply actions are needed, draft the action first and wait for human approval before executing it. "
            f"Always include the thread_id `{thread_id}` whenever a tool accepts it. "
            f"{doc_text}"
        )
    )


def _tool_message_from_call(thread_id: str, tool_call: dict[str, Any]) -> ToolMessage:
    tool_name = tool_call["name"]
    tool = TOOL_REGISTRY.get(tool_name)
    if tool is None:
        raise HTTPException(status_code=400, detail=f"Unknown tool requested: {tool_name}")

    args = dict(tool_call.get("args", {}) or {})
    if tool_name in THREAD_AWARE_TOOL_NAMES and "thread_id" not in args:
        args["thread_id"] = thread_id

    try:
        result = tool.invoke(args)
        result_text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    except Exception as e:
        result_text = json.dumps({"error": str(e)}, ensure_ascii=False)
    return ToolMessage(
        content=result_text,
        name=tool_name,
        tool_call_id=tool_call.get("id", str(uuid.uuid4())),
    )


def _create_pending_approval(
    thread_id: str,
    assistant_message: str,
    tool_calls: list[dict[str, Any]],
) -> dict:
    approval_id = str(uuid.uuid4())
    conn = _connect()
    conn.execute(
        """INSERT INTO pending_actions
           (approval_id, thread_id, assistant_message, tool_calls_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (approval_id, thread_id, assistant_message, json.dumps(tool_calls), "pending", _now()),
    )
    conn.commit()
    conn.close()
    return {
        "approval_id": approval_id,
        "thread_id": thread_id,
        "assistant_message": assistant_message,
        "tool_calls": tool_calls,
    }


def _load_pending_approval(approval_id: str) -> Optional[sqlite3.Row]:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM pending_actions WHERE approval_id = ?", (approval_id,)
    ).fetchone()
    conn.close()
    return row


def _mark_pending_approval(approval_id: str, status: str, note: str = "") -> None:
    conn = _connect()
    conn.execute(
        """UPDATE pending_actions
           SET status = ?, resolved_at = ?, resolution_note = ?
           WHERE approval_id = ?""",
        (status, _now(), note, approval_id),
    )
    conn.commit()
    conn.close()


def clear_thread_context(thread_id: str) -> None:
    _THREAD_RETRIEVERS.pop(str(thread_id), None)
    _THREAD_METADATA.pop(str(thread_id), None)


def delete_thread(thread_id: str) -> None:
    conn = _connect()
    try:
        conn.execute("DELETE FROM chat_messages WHERE thread_id = ?", (thread_id,))
        conn.execute("DELETE FROM pending_actions WHERE thread_id = ?", (thread_id,))
        conn.execute("DELETE FROM chat_threads WHERE thread_id = ?", (thread_id,))
        conn.execute("DELETE FROM checkpoints WHERE thread_id = ?", (thread_id,))
        conn.execute("DELETE FROM writes WHERE thread_id = ?", (thread_id,))
        conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete thread: {e}")
    finally:
        conn.close()
    clear_thread_context(thread_id)


def _serialize_messages(thread_id: str) -> list[dict]:
    rows = _message_rows(thread_id)
    return [
        {
            "role": row["role"],
            "content": row["content"],
            "name": row["name"],
            "tool_call_id": row["tool_call_id"],
            "tool_calls": json.loads(row["tool_calls_json"]) if row["tool_calls_json"] else None,
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def _chat_completion(thread_id: str, user_content: Optional[str] = None) -> dict:
    history = _message_history(thread_id)
    if user_content is not None:
        history = [*history, HumanMessage(content=user_content)]

    config = {
        "configurable": {"thread_id": thread_id},
        "metadata": {"thread_id": thread_id},
        "run_name": "web_chat_turn",
    }

    for _ in range(8):
        response = backend.llm_with_tools.invoke([
            _system_message(thread_id),
            *history,
        ], config=config)

        response_text = backend.extract_text(response.content)
        tool_calls = list(getattr(response, "tool_calls", []) or [])
        _append_message(thread_id, "assistant", response_text, tool_calls=tool_calls or None)
        history.append(AIMessage(content=response_text, tool_calls=tool_calls or []))

        if not tool_calls:
            return {
                "status": "complete",
                "assistant_message": response_text,
                "messages": _serialize_messages(thread_id),
            }

        sensitive_calls = [call for call in tool_calls if call.get("name") in SENSITIVE_TOOL_NAMES]
        if sensitive_calls:
            approval = _create_pending_approval(thread_id, response_text, tool_calls)
            return {
                "status": "approval_required",
                "assistant_message": response_text,
                "approval": approval,
                "messages": _serialize_messages(thread_id),
            }

        for call in tool_calls:
            tool_message = _tool_message_from_call(thread_id, call)
            history.append(tool_message)
            _append_message(
                thread_id,
                "tool",
                tool_message.content,
                name=tool_message.name,
                tool_call_id=tool_message.tool_call_id,
            )

    raise HTTPException(status_code=500, detail="Tool loop exceeded the safe execution limit.")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/threads")
def api_list_threads() -> list[dict]:
    return list_threads()


@app.post("/api/threads")
def api_create_thread() -> dict:
    return create_thread()


@app.get("/api/threads/{thread_id}")
def api_get_thread(thread_id: str) -> dict:
    _ensure_thread(thread_id)
    _load_checkpoint_history(thread_id)
    conn = _connect()
    thread = conn.execute(
        "SELECT thread_id, title, created_at, updated_at FROM chat_threads WHERE thread_id = ?",
        (thread_id,),
    ).fetchone()
    pending = conn.execute(
        "SELECT * FROM pending_actions WHERE thread_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        (thread_id,),
    ).fetchone()
    conn.close()

    if thread is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    pending_payload = None
    if pending is not None:
        pending_payload = {
            "approval_id": pending["approval_id"],
            "assistant_message": pending["assistant_message"],
            "tool_calls": json.loads(pending["tool_calls_json"]),
            "status": pending["status"],
            "created_at": pending["created_at"],
        }

    return {
        "thread": _row_to_thread(thread),
        "messages": _serialize_messages(thread_id),
        "document": backend.thread_document_metadata(thread_id),
        "gmail": {
            "connected": backend.is_authenticated(thread_id),
            "email": backend.get_authenticated_email(thread_id),
            "auth_pending": backend.get_oauth_status(thread_id),
        },
        "pending_approval": pending_payload,
    }


@app.post("/api/threads/{thread_id}/messages")
def api_send_message(thread_id: str, payload: ChatRequest) -> dict:
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Message content is required")

    _ensure_thread(thread_id)
    messages_before = _message_rows(thread_id)
    _append_message(thread_id, "user", content)
    if not messages_before:
        _set_thread_title(thread_id, content)
    _update_thread_touch(thread_id)
    return _chat_completion(thread_id)


@app.post("/api/threads/{thread_id}/pdf")
async def api_upload_pdf(thread_id: str, file: UploadFile = File(...)) -> dict:
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file")

    raw = await file.read()
    summary = backend.ingest_pdf(raw, thread_id=thread_id, filename=file.filename)
    _ensure_thread(thread_id)
    _update_thread_touch(thread_id)
    return {"thread_id": thread_id, "summary": summary}


@app.delete("/api/threads/{thread_id}/context")
def api_clear_thread_context(thread_id: str) -> dict:
    clear_thread_context(thread_id)
    _update_thread_touch(thread_id)
    return {"thread_id": thread_id, "status": "cleared"}


@app.delete("/api/threads/{thread_id}")
def api_delete_thread(thread_id: str) -> dict:
    delete_thread(thread_id)
    return {"status": "deleted"}


@app.post("/api/threads/{thread_id}/gmail/start")
def api_start_gmail(thread_id: str) -> dict:
    backend.start_oauth(thread_id)
    return {"status": "pending", "email": backend.get_authenticated_email(thread_id)}


@app.get("/api/threads/{thread_id}/gmail/status")
def api_gmail_status(thread_id: str) -> dict:
    return {
        "connected": backend.is_authenticated(thread_id),
        "email": backend.get_authenticated_email(thread_id),
        "auth_pending": backend.get_oauth_status(thread_id),
    }


@app.post("/api/approvals/{approval_id}/respond")
def api_respond_to_approval(approval_id: str, payload: ApprovalRequest) -> dict:
    pending = _load_pending_approval(approval_id)
    if pending is None:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if pending["status"] != "pending":
        raise HTTPException(status_code=409, detail="Approval request was already resolved")

    thread_id = pending["thread_id"]
    if not payload.approved:
        _mark_pending_approval(approval_id, "rejected", "Rejected by user")
        _append_message(thread_id, "assistant", "I cancelled that action after your review.")
        return {
            "status": "rejected",
            "messages": _serialize_messages(thread_id),
        }

    tool_calls = json.loads(pending["tool_calls_json"])
    for call in tool_calls:
        tool_message = _tool_message_from_call(thread_id, call)
        _append_message(
            thread_id,
            "tool",
            tool_message.content,
            name=tool_message.name,
            tool_call_id=tool_message.tool_call_id,
        )

    _mark_pending_approval(approval_id, "approved", "Approved by user")
    # Use raw LLM (no tool binding) for a plain-text confirmation
    history = _message_history(thread_id)
    confirmation = backend.llm.invoke([
        SystemMessage(content="The user approved the action and it has been executed. Confirm what happened to the user in 1-2 sentences. Do not call any tools."),
        *history,
    ])
    confirm_text = backend.extract_text(confirmation.content)
    _append_message(thread_id, "assistant", confirm_text)
    return {
        "status": "approved",
        "approval_id": approval_id,
        "assistant_message": confirm_text,
        "messages": _serialize_messages(thread_id),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app_server:app", host="0.0.0.0", port=8000, reload=True)