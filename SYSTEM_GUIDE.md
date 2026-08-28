# ✦ English AI Tutor — System Architecture, Admin Manual & User Guide

Welcome to the complete technical documentation, administration manual, and user guide for the **English AI Tutor RAG Pipeline** built for [englishwithadifference.com](https://www.englishwithadifference.com).

---

## 🏗️ 1. System Overview & Architecture

The system is a production-grade **Retrieval-Augmented Generation (RAG)** platform customized for CBSE Class 9–12 English literature, grammar, and writing skills.

```
                  ┌─────────────────────────────────────────────────────────┐
                  │          Wix Site: englishwithadifference.com           │
                  │   ┌─────────────────────────────────────────────────┐   │
                  │   │ launcher.html (Custom Code, Floating FAB Button)│   │
                  │   └────────────────────────┬────────────────────────┘   │
                  └────────────────────────────┼────────────────────────────┘
                                         postMessage (HTML5 Cross-Origin)
                                               │ (Sends current page URL)
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │    Chatbot Widget: /widget.html (Render Hosted)         │
                  │    - Native Deep Maroon (#7B1C1C) & Georgia Serif     │
                  │    - Glowing AI Star Logo (✦)                           │
                  │    - Dynamic Suggestion Chips                           │
                  └────────────────────────────┬────────────────────────────┘
                                               │ POST /ask { question, pageUrl }
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │    Node.js Express Backend (Render Platform)            │
                  │    - Route: /ask, /suggestions, /admin, /digest, /sync  │
                  │    - IP Rate Limiting & Bearer Token Authentication     │
                  └──────────────┬───────────────────────────┬──────────────┘
                                 │                           │
                   Vector Search │ (Cosine 384d)             │ LPU Chat Completions
                                 ▼                           ▼
            ┌───────────────────────────┐         ┌───────────────────────────┐
            │   MongoDB Atlas Cloud     │         │   Groq LPU Engine         │
            │   - 3,186 Knowledge Chunks│         │   - groq/compound-mini    │
            │   - $vectorSearch Index   │         │     (Llama 3.3 70B)       │
            │   - query_logs Collection │         │   - qwen/qwen3.6-27b      │
            └───────────────────────────┘         └───────────────────────────┘
```

---

## ✨ 2. Core Capabilities & Features

### ⚡ Ultra-Fast Groq Inference Engine
- **Primary Engine**: `groq/compound-mini` (routes to Meta Llama 3.3 70B on Groq LPUs).
- **Turnaround Time**: Under 1.0 second.
- **Free Tier Capacity**: **14,400 requests per day** (30 requests/minute).
- **Multi-Model Fallback Chain**: `groq/compound-mini` ➔ `qwen/qwen3.6-27b` ➔ `openai/gpt-oss-20b`.

### 📄 Page-Aware Contextual Answering (Cross-Origin `postMessage`)
- Uses HTML5 `postMessage` between Wix parent page and Render iframe to bypass cross-origin browser restrictions.
- Automatically queries MongoDB directly for the student's current URL path (e.g. `/post/my-mother-at-sixty-six-by-kamala-das`).
- Prepend page-specific chunks to vector matches, allowing instant, accurate answers for meta-questions like *"What page am I at?"* or *"Summarize this lesson"*.

### 📚 Vector Store RAG Pipeline
- **Local Embedding Model**: ONNX `Xenova/all-MiniLM-L6-v2` (384 dimensions, 23.8ms query embedding time).
- **Cloud Database**: MongoDB Atlas cluster (`wix_rag_pipeline.knowledge_base`).
- **Indexed Chunks**: 3,186 text chunks covering CBSE literature, grammar rules, worksheets, and board exam PYQs.

### 🔗 Inline Citations & References Section
- LLM outputs markdown links `[Source Title](URL)` inline.
- Frontend converts citations into clickable maroon links and appends a formatted **References** pill list (`[1]`, `[2]`) at the bottom of responses.

### 🤖 Dynamic Suggestion Chips
- **Endpoint**: `GET /suggestions`
- Analyzes recent query logs from MongoDB and uses Groq to synthesize **5 concise, high-converting quick-tap chips** every hour.

### 🔄 Incremental Auto-Sync (`POST /sync`)
- Parses live sitemaps (`sitemap.xml`, `blog-posts-sitemap.xml`).
- Diffs URLs against MongoDB `knowledge_base`.
- Scrapes, chunks, embeds, and uploads **only new blog posts** — avoiding re-processing existing data.

### 🛡️ Passcode Admin Portal (`/admin`)
- **Login Modal**: Passcode authentication (`ADMIN_KEY`) with `sessionStorage` token storage.
- **URL Sanitization**: Automatically strips `?key=...` from browser address bar.
- **Brute-Force Protection**: 5 failed login attempts lock out the IP address for 15 minutes.

### ✨ Admin AI Intelligence Engine (`GET /admin/analysis`)
- On-demand AI analysis summarizing student question trends, identified content gaps, and **3–5 concrete website improvement recommendations** for admins to enhance site content.

### ✉ Automated Weekly Email Digest (`POST /digest`)
- Sends an HTML report from `monojoycodes@gmail.com` to `himonotosh@gmail.com` and `monojoydey9@gmail.com` via Gmail SMTP Nodemailer.

---

## 🛠️ 3. Admin Operating Manual

### Environment Variables Checklist (Render Dashboard)

Configure these in **[Render Dashboard](https://dashboard.render.com)** ➔ `rag-on-blog-posts` ➔ **Environment**:

| Variable Name | Value | Purpose |
|---|---|---|
| `GROQ_API_KEY` | `gsk_...` | Groq LPU API key for ultra-fast Llama inference |
| `MONGODB_URI` | `mongodb+srv://...` | MongoDB Atlas cluster connection string |
| `GMAIL_APP_PASSWORD` | `fvnmpvbkvwtclmqy` | Gmail App Password for sending weekly digests |
| `ADMIN_KEY` | `ewd-admin-2024` | Passcode for Admin Dashboard access |

---

### Installing the Floating Launcher in Wix

1. Go to **Wix Dashboard ➔ Settings ➔ Custom Code**.
2. Click **+ Add Custom Code**.
3. Paste the complete content of [`src/public/launcher.html`](file:///c:/Users/monoj/Documents/antigravity/kind-einstein/src/public/launcher.html).
4. Configure:
   - **Name**: `AI English Tutor`
   - **Place Code in**: `Body - end`
   - **Add code to pages**: `All Pages`
5. Click **Apply** ➔ **Publish Site**.

---

### Setting Up Automated Daily Post Sync (Free)

To automatically index new blog posts every night:

1. Create a free account on **[cron-job.org](https://cron-job.org)**.
2. Click **Create Cronjob**:
   - **Title**: `Wix Blog Auto-Sync`
   - **URL**: `https://rag-on-blog-posts.onrender.com/sync`
   - **Schedule**: Everyday at 00:00 (Midnight)
   - **Method**: `POST`
   - **Headers**: `Authorization: Bearer ewd-admin-2024`, `Content-Type: application/json`
3. Click **Save**.

---

### Operating the Admin Dashboard

- **URL**: `https://rag-on-blog-posts.onrender.com/admin`
- **Passcode**: `ewd-admin-2024`

#### Key Actions Available:
- 🤖 **AI Site Insights**: Generates a live content audit detailing what students are asking and what new articles to write.
- ✉ **Send Digest Now**: Triggers an instant email digest to `himonotosh@gmail.com` and `monojoydey9@gmail.com`.
- 📋 **Recent Queries Feed**: Real-time audit log of student questions, response times, and page context links.

---

## 📖 4. Student & User Guide

### How Students Interact with the AI Tutor

1. **Floating Launcher Button (✦)**:
   - Located at the bottom-right corner of every page on `englishwithadifference.com`.
   - Displays a golden sparkle star logo with a subtle pulsing animation.
   - Tapping it opens the native maroon chatbot panel (slides up full-screen on mobile).

2. **Quick Suggestion Chips**:
   - Scrollable row at the top of the chat panel.
   - Shows top-trending student questions. Tap any chip to send it instantly.

3. **Asking Page-Specific Questions**:
   - While reading any blog post (e.g. *My Mother at Sixty-Six*), students can ask page-specific questions like *"Summarize this lesson"* or *"What page am I at?"*.
   - The AI automatically detects the page and answers directly from that article.

4. **Exploring References**:
   - Every answer includes inline markdown links and a **References** section at the bottom.
   - Students can click any reference pill `[1]`, `[2]` to jump straight to the source lesson on `englishwithadifference.com`.

---

## 📁 5. Repository Structure

```
RAG-on-blog-posts/
├── src/
│   ├── public/
│   │   ├── widget.html      # Redesigned native chatbot interface
│   │   ├── launcher.html    # Wix floating button & postMessage script
│   │   └── admin.html       # Passcode-protected Admin Intelligence Portal
│   ├── server.js            # Express API server & Groq hybrid engine
│   ├── search.js            # Vector search & URL direct retrieval helpers
│   ├── logger.js            # MongoDB query logging & aggregate stats
│   ├── digest.js            # Nodemailer weekly email digest generator
│   └── sync.js              # Incremental sitemap scraper & chunk embedder
├── SYSTEM_GUIDE.md          # Full System Architecture & Operating Manual
├── .env                     # Local environment variables (gitignored)
├── package.json             # Node dependencies & scripts
└── README.md                # Project README
```
