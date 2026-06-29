# LangGraph Multi-Utility Chatbot

A multi-threaded chatbot built with **LangGraph**, **Streamlit**, and **Google Gemini**. Supports PDF-based RAG, web search, stock price lookup, a calculator, and **full Gmail integration** (read, search, send, reply, attachments).

## Features

- **Multi-threaded conversations** — create new chats or resume past ones
- **PDF RAG** — upload a PDF, index it with FAISS, and ask questions about its content
- **Web search** — via DuckDuckGo
- **Stock prices** — fetched from Alpha Vantage
- **Calculator** — basic arithmetic operations
- **Gmail integration** — sign in with Google OAuth, then:
  - Read and search emails
  - Get full email content with body
  - Send new emails
  - Reply to existing threads
  - List and download attachments
- **Agent auto-selects tools** — the LLM decides which tool to call based on your question
- **Persistent history** — chat history saved via LangGraph's SQLite checkpointer

## Setup

1. Clone the repo and install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and fill in your API keys:
   - `GEMINI_API_KEY` — Google Generative AI API key
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Gmail OAuth credentials (see below)
   - `LANGCHAIN_API_KEY` — (optional) LangSmith tracing

3. Run the app:
   ```bash
   streamlit run langgraph-frontend.py
   ```

## Gmail Setup

1. Go to https://console.cloud.google.com/
2. Create a project → enable **Gmail API**
3. Go to **APIs & Services → OAuth consent screen** → External → add your email as a test user
4. Go to **Credentials → Create Credentials → OAuth client ID** → **Desktop app**
5. Copy the Client ID and Client Secret into `.env`:
   ```
   GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="GOCSPX-xxx"
   ```
6. Launch the app, click **Sign in with Google** in the sidebar — a browser opens automatically, complete the flow.

## Project Structure

| File | Description |
|---|---|
| `langgraph_backend.py` | LangGraph state graph, tools (search, stock, calculator, RAG, Gmail), LLM + embeddings |
| `langgraph-frontend.py` | Streamlit UI — chat, PDF upload sidebar, Gmail login, thread management |
| `gmail_tools.py` | Gmail OAuth (local-server flow), token persistence, 7 Gmail tools |
| `chatbot.db` | SQLite database for checkpointer state and Gmail tokens |
| `.env` | API keys and OAuth credentials |
| `requirements.txt` | Python dependencies |
