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

// ── Groq API call helper (Primary Ultra-Fast Engine) ────────────────────────
async function generateWithGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in environment variables');

  // Try primary model (groq/compound-mini), fallback to qwen/qwen3.6-27b if needed
  const models = ['groq/compound-mini', 'qwen/qwen3.6-27b'];

  for (const model of models) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.warn(`[Groq] Model ${model} returned HTTP ${res.status}: ${errorText}`);
        continue; // Try next model
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        return content.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
      }
    } catch (err) {
      console.warn(`[Groq] Exception with model ${model}:`, err.message);
    }
  }

  throw new Error('All Groq models failed or rate-limited.');
}

// ── Gemini call helper (Backup Engine) ────────────────────────────────────────
async function generateWithGemini(prompt, maxRetries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

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
        const backoffMs = attempt * 1500;
        console.warn(`[Gemini] Rate limited. Retry ${attempt}/${maxRetries} in ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ── Hybrid LLM Engine: Groq Primary ⚡ → Gemini Backup 🛡 ─────────────────────
async function generateWithRetry(prompt) {
  try {
    // 1. Try Groq (Ultra-fast ~1s turnaround, 14,400 RPD)
    return await generateWithGroq(prompt);
  } catch (groqErr) {
    console.warn(`[LLM Engine] Groq unavailable (${groqErr.message}). Falling back to Gemini...`);
    try {
      // 2. Fallback to Gemini
      return await generateWithGemini(prompt);
    } catch (geminiErr) {
      console.error('[LLM Engine] All LLM providers failed:', geminiErr.message);
      throw new Error('Our AI servers are experiencing high traffic right now. Please try again in a few moments.');
    }
  }
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

// ── Dynamic suggestion chips ──────────────────────────────────────────────────
// Fallback chips shown before enough query data is available
const DEFAULT_SUGGESTIONS = [
  'Who wrote My Mother at Sixty-Six?',
  'Explain reported speech',
  'Class 10 grammar tips',
  'Amanda poem summary',
  'Letter writing format'
];

// In-memory cache (refreshes every hour)
let suggestionCache = { chips: DEFAULT_SUGGESTIONS, updatedAt: 0 };
const SUGGESTION_TTL_MS = 60 * 60 * 1000; // 1 hour

app.get('/suggestions', async (req, res) => {
  const now = Date.now();

  // Serve from cache if fresh
  if (now - suggestionCache.updatedAt < SUGGESTION_TTL_MS) {
    return res.json({ chips: suggestionCache.chips, source: 'cache' });
  }

  try {
    // Fetch top 20 questions from the last 7 days, excluding fallbacks
    const logs = await getRecentLogs(7, 100);
    const nonFallback = logs.filter(l => !l.isFallback);

    if (nonFallback.length < 5) {
      // Not enough real data yet — use defaults
      return res.json({ chips: DEFAULT_SUGGESTIONS, source: 'default' });
    }

    // Count question frequency
    const freq = new Map();
    nonFallback.forEach(l => {
      const q = l.question.trim();
      freq.set(q, (freq.get(q) || 0) + 1);
    });
    const topQuestions = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([q]) => q);

    // Ask Gemini to pick and rephrase the 5 best chips
    const prompt = `You are helping design suggestion chips for an English learning chatbot for CBSE students on "English With A Difference" (englishwithadifference.com).

Here are the top questions students have been asking this week:
${topQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Select the 5 most useful, diverse, and representative questions. Rephrase them to be short (under 8 words), clear, and suitable as quick-tap suggestion chips.

Return ONLY a JSON array of 5 strings, nothing else. Example:
["Who wrote My Mother at Sixty-Six?", "Explain reported speech", "Class 10 grammar tips", "Amanda poem summary", "Letter writing format"]`;

    const answer = await generateWithRetry(prompt);

    // Parse Gemini's JSON response safely
    const jsonMatch = answer.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) throw new Error('Gemini did not return a valid JSON array');
    const chips = JSON.parse(jsonMatch[0]).slice(0, 5);

    // Update cache
    suggestionCache = { chips, updatedAt: now };
    res.json({ chips, source: 'ai' });

  } catch (err) {
    console.warn('[Suggestions] Falling back to defaults:', err.message);
    res.json({ chips: DEFAULT_SUGGESTIONS, source: 'default' });
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

// ── Admin Security & Authentication ──────────────────────────────────────────
const loginAttempts = new Map(); // ip -> { count, lockUntil }

function isIpLocked(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() < record.lockUntil) return true;
  loginAttempts.delete(ip); // lock expired
  return false;
}

function recordFailedLogin(ip) {
  const record = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockUntil = Date.now() + 15 * 60 * 1000; // 15-minute lockout
    console.warn(`[Security] IP ${ip} locked out for 15 minutes due to 5 failed login attempts.`);
  }
  loginAttempts.set(ip, record);
}

function authenticateAdmin(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const key = token || req.query.key || req.body?.key;
  return key === ADMIN_KEY;
}

// ── Admin Dashboard Login & Web Page ─────────────────────────────────────────
app.get('/admin', (req, res) => {
  // Serve the admin dashboard HTML — authentication is handled client-side via login modal
  res.sendFile(path.join(process.cwd(), 'src', 'public', 'admin.html'));
});

// Admin Passcode Login API
app.post('/admin/login', (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  if (isIpLocked(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. IP locked for 15 minutes.' });
  }

  const { passcode } = req.body;
  if (passcode === ADMIN_KEY) {
    loginAttempts.delete(ip); // reset attempts on success
    return res.json({ success: true, token: ADMIN_KEY });
  } else {
    recordFailedLogin(ip);
    const remaining = 5 - (loginAttempts.get(ip)?.count || 0);
    return res.status(401).json({ error: `Invalid admin passcode. ${remaining} attempt(s) remaining.` });
  }
});

// Admin data API (used by admin.html)
app.get('/admin/data', async (req, res) => {
  if (!authenticateAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
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

// Admin AI Insights & Site Improvement Recommendations API
app.get('/admin/analysis', async (req, res) => {
  if (!authenticateAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const [logs, stats] = await Promise.all([
      getRecentLogs(7, 100),
      getStats()
    ]);


    if (logs.length === 0) {
      return res.json({
        analysis: "### No Query Data Yet\n\nThere are no recorded student questions in the last 7 days to analyze. Once students interact with the AI Tutor, detailed insights and recommendations will appear here automatically."
      });
    }

    const sampleQueries = logs
      .map(l => `- Q: "${l.question}" | Fallback: ${l.isFallback ? 'YES (No info found)' : 'NO'}`)
      .join('\n');

    const prompt = `You are a Senior Educational Content Strategist & AI Analytics Director for the website "English With A Difference" (englishwithadifference.com), which helps CBSE Class 9-12 students master English grammar, literature, and writing skills.

Analyze these real student queries from the last 7 days:

Overall Stats:
- Total queries (7d): ${stats.totalWeek}
- Total fallbacks/unanswered (7d): ${stats.fallbackCount}
- Top questions asked:
${stats.topQuestions.map((q, i) => `  ${i + 1}. "${q._id}" (${q.count}x)`).join('\n')}

Log of student queries:
${sampleQueries}

Generate a clear, highly structured, professional Markdown report for the website admins with the following sections:

### 🎓 1. What Students Are Asking (Key Themes & Patterns)
Synthesize the primary topics, poems, grammar rules, or chapters students are seeking help with.

### ⚠️ 2. Content Gaps & Unanswered Topics
Highlight specific questions or topics where the bot struggled or had no content to draw from.

### 💡 3. Recommended Site Content Improvements for Excellence
Give 3-5 concrete, high-impact recommendations on what new blog posts, worksheets, or explanations the website admins should publish or refine on englishwithadifference.com to make the site the ultimate reference.

### 🚀 4. Priority Admin Action Items
List 3 clear, prioritized next steps for the team.

Use clear formatting, bold key terms, and bullet points. Make it insightful and actionable.`;

    const analysis = await generateWithRetry(prompt);
    res.json({ analysis, timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('Admin analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Email digest ──────────────────────────────────────────────────────────────
app.post('/digest', async (req, res) => {
  if (!authenticateAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
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
  if (!authenticateAdmin(req)) return res.status(403).json({ error: 'Forbidden' });

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
