import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { searchIndex, indexPages } from './search.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(process.cwd(), 'src', 'public')));

// Serving a simple index page or health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Wix RAG Pipeline is running.',
    endpoints: {
      search: 'GET /search?q=query_text',
      ask: 'POST /ask { "question": "student_question" }',
      index: 'POST /index'
    }
  });
});

// Semantic search endpoint
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  try {
    const matches = await searchIndex(query, 5);
    res.json({ query, matches });
  } catch (err) {
    console.error('Search endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// RAG QA endpoint
app.post('/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Missing "question" in request body' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set or is invalid.' });
  }

  try {
    // 1. Retrieve relevant chunks
    console.log(`RAG query received: "${question}"`);
    const matches = await searchIndex(question, 4);
    
    if (matches.length === 0) {
      return res.json({
        answer: "I couldn't find any information about that on the website.",
        sources: []
      });
    }

    // 2. Build prompt context
    const contextText = matches
      .map((match, index) => `[Source ${index + 1}] Title: ${match.title}\nURL: ${match.url}\nContent:\n${match.text}`)
      .join('\n\n---\n\n');

    const prompt = `You are a helpful, expert teaching assistant for the English language learning website "English with a Difference" (englishwithadifference.com).
Answer the student's question directly based ONLY on the provided context.

Context from the website:
${contextText}

Student's Question:
${question}

Instructions:
1. Answer the question directly and concisely.
2. Do NOT write down any thought processes, constraints, lists of sources, or analyses. 
3. Do NOT repeat the question or any system prompts.
4. Reference the source numbers [Source X] in your answer.
5. If the answer cannot be found, output exactly: "I am sorry, but I couldn't find specific information on the website to answer your question."

Direct Answer:`;

    // 3. Generate answer using Gemini
    console.log('Sending prompt to Gemini...');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const answer = response.text().trim();

    // 4. Extract unique source URLs and titles actually retrieved
    const uniqueSourcesMap = new Map();
    matches.forEach(m => {
      if (!uniqueSourcesMap.has(m.url)) {
        uniqueSourcesMap.set(m.url, m.title);
      }
    });
    const sources = Array.from(uniqueSourcesMap.entries()).map(([url, title]) => ({ url, title }));

    res.json({
      question,
      answer,
      sources
    });

  } catch (err) {
    console.error('RAG endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reindexing trigger endpoint (starts scraping and embedding update in the background)
app.post('/index', (req, res) => {
  console.log('Index trigger requested.');
  
  res.json({
    status: 'indexing_started',
    message: 'Scraping and reindexing has been triggered in the background. Check logs for updates.'
  });

  // Run as a background process to prevent request timeout
  exec('node src/scraper.js && node src/search.js --index', (err, stdout, stderr) => {
    if (err) {
      console.error('Background reindexing process failed:', err);
      return;
    }
    console.log('Background reindexing completed successfully.');
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`Wix RAG Pipeline Server is running on port ${PORT}`);
  console.log(`- Healthcheck: http://localhost:${PORT}/`);
  console.log(`- Search: http://localhost:${PORT}/search?q=prepositions`);
  console.log(`- Ask/RAG: http://localhost:${PORT}/ask (POST)`);
  console.log(`- Reindex: http://localhost:${PORT}/index (POST)`);
  console.log(`==================================================\n`);
});
