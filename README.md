# LangGraph Multi-Utility Chatbot

A multi-threaded chatbot built with **LangGraph**, **Streamlit**, and **Google Gemini**. Supports PDF-based RAG, web search, stock price lookup, and a calculator tool.

## Features

- **Multi-threaded conversations** — create new chats or resume past ones
- **PDF RAG** — upload a PDF, index it with FAISS, and ask questions about its content
- **Web search** — via DuckDuckGo
- **Stock prices** — fetched from Alpha Vantage
- **Calculator** — basic arithmetic operations
- **Persistent history** — chat history saved via LangGraph's SQLite checkpointer

## Setup

1. Clone the repo and install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and fill in your API keys:
   - `GEMINI_API_KEY` — Google Generative AI API key
   - `LANGCHAIN_API_KEY` — (optional) LangSmith tracing

3. Run the app:
   ```bash
   streamlit run langgraph-frontend.py
   ```

## Project Structure

- `langgraph_backend.py` — LangGraph state graph, tools, PDF ingestion, and LLM logic
- `langgraph-frontend.py` — Streamlit UI for chat and PDF upload
- `chatbot.db` — SQLite database for checkpoint/persistence
- `.env` — API keys configuration
