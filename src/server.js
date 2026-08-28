import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { searchIndex, indexPages } from './search.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logQuery, getRecentLogs, getStats } from './logger.js';
import { runDigest } from './digest.js';
import { syncNewPosts } from './sync.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(process.cwd(), 'src', 'public')));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'English AI Tutor RAG Pipeline is running.',
    endpoints: {
      search: 'GET /search?q=query_text',
      ask: 'POST /ask { "question": "...", "pageUrl": "(optional)" }',
      admin: 'GET /admin?key=ADMIN_KEY',
      adminData: 'GET /admin/data?key=ADMIN_KEY',
      digest: 'POST /digest { "key": "ADMIN_KEY" }',
      sync: 'POST /sync { "key": "ADMIN_KEY" }',
    }
  });
});

// ── Gemini with exponential backoff retry ─────────────────────────────────────
async function generateWithRetry(prompt, maxRetries = 3) {
  const apiKey = process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      lastError = err;
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
      if (isRateLimit && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1500; // 3s, 6s, 12s
        console.warn(`[Gemini] Rate limited. Retry ${attempt}/${maxRetries} in ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ── Semantic search ───────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query parameter "q"' });
  try {
    const matches = await searchIndex(query, 5);
    res.json({ query, matches });
  } catch (err) {
    console.error('Search endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── RAG /ask endpoint ─────────────────────────────────────────────────────────
app.post('/ask', async (req, res) => {
  const { question, pageUrl } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing "question" in request body' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set.' });
  }

  const startTime = Date.now();

  try {
    console.log(`RAG query: "${question}" | Page: ${pageUrl || 'none'}`);

    // 1. Retrieve relevant chunks via vector search
    const matches = await searchIndex(question, 5);

    if (matches.length === 0) {
      const fallback = "I am sorry, but I couldn't find specific information on the website to answer your question.";
      await logQuery({ question, answer: fallback, sources: [], pageUrl, durationMs: Date.now() - startTime });
      return res.json({ question, answer: fallback, sources: [] });
    }

    // 2. [F3] Page-aware boost: if student is on a specific page, move matching chunks to front
    let sortedMatches = matches;
    if (pageUrl) {
      const pageChunks = matches.filter(m => m.url && pageUrl.includes(m.url.replace(/https?:\/\/[^/]+/, '')));
      const otherChunks = matches.filter(m => !pageChunks.includes(m));
      sortedMatches = [...pageChunks, ...otherChunks].slice(0, 4);
    } else {
      sortedMatches = matches.slice(0, 4);
    }

    // 3. Build context — each source gets an index and its URL for citation
    const contextText = sortedMatches
      .map((m, i) => `[Source ${i + 1}] Title: "${m.title}"\nURL: ${m.url}\nContent:\n${m.text}`)
      .join('\n\n---\n\n');

    // 4. [F1] Updated prompt: ask LLM to cite using markdown link syntax
    const pageHint = pageUrl
      ? `\nNote: The student is currently viewing the page: ${pageUrl}. Prioritise sources from this page where relevant.\n`
      : '';

    const prompt = `You are a helpful, expert teaching assistant for the English language learning website "English with a Difference" (englishwithadifference.com).
Answer the student's question directly based ONLY on the provided context.
${pageHint}
Context from the website:
${contextText}

Student's Question:
${question}

Instructions:
1. Answer the question directly and concisely.
2. Do NOT write thought processes, constraint lists, or analyses.
3. Do NOT repeat the question or system prompts.
4. When citing a source, use markdown link format: [Source Title](URL) — use the exact Title and URL from context.
5. At the end of your answer, list all cited sources as a markdown numbered list under the heading "**References**".
6. If the answer cannot be found, output exactly: "I am sorry, but I couldn't find specific information on the website to answer your question."

Direct Answer:`;

    // 5. Generate answer with retry
    const answer = await generateWithRetry(prompt);

    // 6. Build deduped sources array
    const uniqueSourcesMap = new Map();
    sortedMatches.forEach(m => {
      if (!uniqueSourcesMap.has(m.url)) uniqueSourcesMap.set(m.url, m.title);
    });
    const sources = Array.from(uniqueSourcesMap.entries()).map(([url, title]) => ({ url, title }));

    // 7. [F2] Log to MongoDB (non-blocking)
    logQuery({ question, answer, sources, pageUrl, durationMs: Date.now() - startTime });

    res.json({ question, answer, sources });

  } catch (err) {
    console.error('RAG endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin dashboard ───────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send('Forbidden: Invalid admin key. Add ?key=YOUR_ADMIN_KEY to the URL.');
  }
  res.sendFile(path.join(process.cwd(), 'src', 'public', 'admin.html'));
});

// Admin data API (used by admin.html)
app.get('/admin/data', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  try {
    const [logs, stats] = await Promise.all([
      getRecentLogs(7, 20),
      getStats()
    ]);
    res.json({ logs, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email digest ──────────────────────────────────────────────────────────────
app.post('/digest', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  try {
    const result = await runDigest();
    res.json(result);
  } catch (err) {
    console.error('Digest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Incremental sync ──────────────────────────────────────────────────────────
app.post('/sync', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });

  // Respond immediately — sync runs in background (can take several minutes)
  res.json({ status: 'sync_started', message: 'Incremental sync started in background. Check server logs for progress.' });

  syncNewPosts()
    .then(result => console.log('[Sync] Complete:', result))
    .catch(err => console.error('[Sync] Failed:', err.message));
});

// ── Legacy reindex ────────────────────────────────────────────────────────────
app.post('/index', (req, res) => {
  res.json({ status: 'deprecated', message: 'Use POST /sync instead for incremental updates.' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`English AI Tutor RAG Pipeline — Port ${PORT}`);
  console.log(`- Healthcheck:  http://localhost:${PORT}/`);
  console.log(`- Ask:          POST http://localhost:${PORT}/ask`);
  console.log(`- Admin:        http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  console.log(`- Sync:         POST http://localhost:${PORT}/sync`);
  console.log(`- Digest:       POST http://localhost:${PORT}/digest`);
  console.log(`==================================================\n`);
});
