from __future__ import annotations

import base64
import json
import os
import sqlite3
import threading
from email.mime.text import MIMEText
from typing import Optional

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow, InstalledAppFlow
from googleapiclient.discovery import build
from langchain_core.tools import tool

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
]

TOKEN_DB = "chatbot.db"

# In-memory state for background OAuth flows
_pending_auth: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Token persistence — one token per thread_id
# ---------------------------------------------------------------------------
def _ensure_table():
    conn = sqlite3.connect(TOKEN_DB, check_same_thread=False)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS gmail_tokens (
               key TEXT PRIMARY KEY,
               token_json TEXT,
               email TEXT
           )"""
    )
    conn.commit()
    conn.close()


def _save_tokens(thread_id: str, creds: Credentials, email_addr: str = ""):
    _ensure_table()
    conn = sqlite3.connect(TOKEN_DB, check_same_thread=False)
    conn.execute(
        "INSERT OR REPLACE INTO gmail_tokens (key, token_json, email) VALUES (?, ?, ?)",
        (thread_id, creds.to_json(), email_addr),
    )
    conn.commit()
    conn.close()


def _load_tokens(thread_id: str) -> Optional[dict]:
    _ensure_table()
    conn = sqlite3.connect(TOKEN_DB, check_same_thread=False)
    row = conn.execute(
        "SELECT token_json, email FROM gmail_tokens WHERE key = ?",
        (thread_id,),
    ).fetchone()
    conn.close()
    if row:
        return {"token_json": row[0], "email": row[1]}
    return None


# ---------------------------------------------------------------------------
# OAuth — local‑server flow (no manual copy‑paste)
# ---------------------------------------------------------------------------
#creates the OAuth Flow object that knows how to authenticate with Google.
def _make_flow():
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError(
            "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not set in .env"
        )
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uris": ["http://localhost"],
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    return InstalledAppFlow.from_client_config(client_config, SCOPES)

# ---------------------------------------------------------------------------
# OAuth — web‑server flow (redirect‑based, for production)
# ---------------------------------------------------------------------------
def _make_web_flow(redirect_uri: str):
    client_id = os.getenv("GOOGLE_CLIENT_ID_WEB_GMAIL")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET_WEB_GMAIL")
    if not client_id or not client_secret:
        raise RuntimeError("GOOGLE_CLIENT_ID_WEB_GMAIL and GOOGLE_CLIENT_SECRET_WEB_GMAIL not set")
    client_config = {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uris": [redirect_uri],
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
    return Flow.from_client_config(client_config, SCOPES, redirect_uri=redirect_uri)


def generate_auth_url(thread_id: str) -> str:
    """Generate a Google OAuth URL for the user to visit in their browser."""
    redirect_uri = os.getenv(
        "GMAIL_REDIRECT_URI",
        "http://localhost:8000/api/gmail/callback",
    )
    flow = _make_web_flow(redirect_uri)
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        state=thread_id,
        prompt="consent",
    )
    _pending_auth[thread_id] = {"status": "pending", "auth_url": auth_url}
    return auth_url


def handle_oauth_callback(thread_id: str, code: str) -> None:
    """Exchange authorization code for credentials and save them."""
    redirect_uri = os.getenv(
        "GMAIL_REDIRECT_URI",
        "http://localhost:8000/api/gmail/callback",
    )
    flow = _make_web_flow(redirect_uri)
    flow.fetch_token(code=code)
    creds = flow.credentials

    service = build("gmail", "v1", credentials=creds)
    profile = service.users().getProfile(userId="me").execute()
    email_addr = profile.get("emailAddress", "")

    _save_tokens(thread_id, creds, email_addr)
    _pending_auth[thread_id] = {"status": "done", "email": email_addr}


#starts google sign-in
def start_oauth(thread_id: str) -> Optional[str]:
    """Start Gmail OAuth. Returns an auth_url in production (web flow),
    or None in local dev (background local-server flow)."""
    if os.getenv("GOOGLE_CLIENT_ID_WEB_GMAIL"):
        return generate_auth_url(thread_id)

    def _run():
        try:
            flow = _make_flow()
            creds = flow.run_local_server(
                host="localhost",
                port=0,
                open_browser=True,
            )
            service = build("gmail", "v1", credentials=creds)
            profile = service.users().getProfile(userId="me").execute()
            email_addr = profile.get("emailAddress", "")
            _save_tokens(thread_id, creds, email_addr)
            _pending_auth[thread_id] = {"status": "done", "email": email_addr}
        except Exception as exc:
            _pending_auth[thread_id] = {"status": "error", "error": str(exc)}

    _pending_auth[thread_id] = {"status": "pending"}
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return None


def get_oauth_status(thread_id: str) -> Optional[dict]:
    """Return the status dict for an in‑progress or completed OAuth flow."""
    return _pending_auth.get(thread_id) #status -pending,error,done


def get_credentials(thread_id: str = "") -> Optional[Credentials]:
    """Return valid (possibly refreshed) credentials for a thread."""
    data = _load_tokens(thread_id)
    if not data:
        return None

    #Converts JSON stored in database into an actual Credentials object.
    creds = Credentials.from_authorized_user_info(json.loads(data["token_json"]))

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())#new refresh token
        _save_tokens(thread_id, creds, data.get("email", ""))

    return creds


def _get_service(thread_id: str = ""):
    creds = get_credentials(thread_id)
    if not creds:
        raise PermissionError("Gmail not connected. Sign in with Google first.")
    return build("gmail", "v1", credentials=creds)


def is_authenticated(thread_id: str = "") -> bool:
    try:
        creds = get_credentials(thread_id)
        return creds is not None and creds.valid
    except Exception:
        return False


def get_authenticated_email(thread_id: str = "") -> str:
    data = _load_tokens(thread_id)
    return data.get("email", "") if data else ""


# ---------------------------------------------------------------------------
# Tools (each accepts thread_id so the LLM can pass it through)
# ---------------------------------------------------------------------------
@tool
def read_emails(thread_id: str, max_results: int = 10, query: str = "") -> list:
    """Fetch recent emails from the inbox. Optionally filter with a Gmail search
    query (e.g. 'from:someone@example.com')."""
    service = _get_service(thread_id)
    #GET https://gmail.googleapis.com/gmail/v1/users/me/messages what it does
    results = (
        service.users()
        .messages()
        .list(userId="me", maxResults=max_results, q=query)
        .execute()
    )
    messages = results.get("messages", [])

    emails = []
    for msg in messages:
        data = (
            service.users()
            .messages()
            .get(
                userId="me",
                id=msg["id"],
                format="metadata",
                metadataHeaders=["From", "Subject", "Date"],# without it gmail return only header
                #save bandwidth only required things fetched
            )
            .execute()
        )
        #headers -> dict
        headers = {h["name"]: h["value"] for h in data.get("payload", {}).get("headers", [])}
        emails.append(
            {
                "id": msg["id"],
                "thread_id": data.get("threadId"),
                "from": headers.get("From", ""),
                "subject": headers.get("Subject", ""),
                "date": headers.get("Date", ""),
                "snippet": data.get("snippet", ""),
            }
        )
    return emails


@tool
def search_emails(thread_id: str, query: str, max_results: int = 10) -> list:
    """Search emails using Gmail search syntax.

    Examples:
      'from:someone@example.com'
      'after:2024/1/1 before:2024/6/1'
      'has:attachment'
    """
    return read_emails.invoke({"thread_id": thread_id, "max_results": max_results, "query": query})


@tool
def get_email_content(thread_id: str, message_id: str) -> dict:
    """Retrieve the full body and headers of a specific email by its message ID."""
    service = _get_service(thread_id)
    data = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )

    headers = {h["name"]: h["value"] for h in data.get("payload", {}).get("headers", [])}

    body = ""
    stack = [data["payload"]]
    while stack:
        part = stack.pop()
        mime = part.get("mimeType", "")
        body_data = part.get("body", {}).get("data", "")
        if mime == "text/plain" and body_data:
            body = base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")
            break
        if mime == "text/html" and not body and body_data:
            body = base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")
        stack.extend(part.get("parts", []))

    return {
        "id": message_id,
        "thread_id": data.get("threadId"),
        "from": headers.get("From", ""),
        "to": headers.get("To", ""),
        "subject": headers.get("Subject", ""),
        "date": headers.get("Date", ""),
        "body": body,
    }


@tool
def send_email(thread_id: str, to: str, subject: str, body: str, cc: str = "") -> dict:
    """Send a new email to one or more recipients."""
    service = _get_service(thread_id)

    #Multipurpose Internet Mail Extensions (creates properly formatted email containing text.)
    msg = MIMEText(body)
    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = cc

    #gmail api wants it in this 
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    sent = service.users().messages().send(userId="me", body={"raw": raw}).execute()

    return {
        "status": "sent",
        "message_id": sent.get("id"),
        "to": to,
        "subject": subject,
    }


@tool
def reply_to_email(thread_id: str, message_id: str, body: str) -> dict:
    """Reply to an existing email thread by providing the message ID to reply to."""
    service = _get_service(thread_id)

    original = (
        service.users()
        .messages()
        .get(
            userId="me",
            id=message_id,
            format="metadata",
            metadataHeaders=["From", "Subject", "Message-ID", "References"],
        )
        .execute()
    )
    h = {k["name"]: k["value"] for k in original.get("payload", {}).get("headers", [])}

    subject = h.get("Subject", "")
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"

    msg = MIMEText(body)
    msg["To"] = h.get("From", "")
    msg["Subject"] = subject
    msg["In-Reply-To"] = h.get("Message-ID", "")
    msg["References"] = (h.get("References", "") + " " + h.get("Message-ID", "")).strip()

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    sent = (
        service.users()
        .messages()
        .send(userId="me", body={"raw": raw, "threadId": original.get("threadId")})
        .execute()
    )

    return {
        "status": "replied",
        "message_id": sent.get("id"),
        "to": h.get("From", ""),
        "subject": subject,
    }


@tool
def get_attachments_metadata(thread_id: str, message_id: str) -> list:
    """List attachment filenames and types in a specific email."""
    service = _get_service(thread_id)
    data = (
        service.users()
        .messages()
        .get(userId="me", id=message_id, format="full")
        .execute()
    )

    results = []
    stack = [data["payload"]]
    while stack:
        part = stack.pop()
        if part.get("filename") and part.get("body", {}).get("attachmentId"):
            results.append(
                {
                    "filename": part["filename"],
                    "mime_type": part.get("mimeType", ""),
                    "size": part.get("body", {}).get("size", 0),
                    "attachment_id": part["body"]["attachmentId"],
                    "message_id": message_id,
                }
            )
        stack.extend(part.get("parts", []))
    return results


@tool
def download_attachment(
    thread_id: str, message_id: str, attachment_id: str, filename: str = ""
) -> dict:
    """Download an attachment and return it base64-encoded so the LLM can
    process it (e.g. summarise a PDF)."""
    service = _get_service(thread_id)
    att = (
        service.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=message_id, id=attachment_id)
        .execute()
    )

    raw_bytes = base64.urlsafe_b64decode(att["data"])
    return {
        "filename": filename or f"{attachment_id}",
        "mime_type": att.get("mimeType", ""),
        "size": len(raw_bytes),
        "data_base64": base64.b64encode(raw_bytes).decode("utf-8"),
    }


# Export list for easy registration in the backend
gmail_tools = [
    read_emails,
    search_emails,
    get_email_content,
    send_email,
    reply_to_email,
    get_attachments_metadata,
    download_attachment,
]
