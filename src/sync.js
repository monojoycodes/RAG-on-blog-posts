/**
 * sync.js — Incrementally syncs new blog posts from the live website into MongoDB.
 *
 * Strategy:
 *  1. Fetch all page URLs from the Wix sitemap.
 *  2. Query MongoDB for all URLs already in the knowledge_base.
 *  3. Find the diff — URLs in sitemap but NOT yet in the database.
 *  4. Scrape, chunk, embed, and upload ONLY the new pages.
 *
 * This avoids re-processing all 3,186+ existing chunks on every run.
 */

import * as cheerio from 'cheerio';
import { pipeline } from '@xenova/transformers';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = 'https://www.englishwithadifference.com';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MongoDB ──────────────────────────────────────────────────────────────────

let syncClient = null;
async function getKnowledgeBase() {
  if (!syncClient) {
    syncClient = new MongoClient(process.env.MONGODB_URI);
    await syncClient.connect();
  }
  return syncClient.db('wix_rag_pipeline').collection('knowledge_base');
}

// ── Sitemap helpers (reused from scraper.js logic) ───────────────────────────

async function fetchWithTimeout(url, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 EnglishRAGBot/1.0' }
    });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function getAllSitemapUrls() {
  const urls = new Set();
  try {
    const mainRes = await fetchWithTimeout(SITEMAP_URL);
    const mainXml = await mainRes.text();
    const $main = cheerio.load(mainXml, { xmlMode: true });

    const subSitemaps = [];
    $main('sitemap loc').each((_, el) => subSitemaps.push($main(el).text().trim()));

    if (subSitemaps.length === 0) {
      subSitemaps.push(
        `${BASE_URL}/pages-sitemap.xml`,
        `${BASE_URL}/blog-posts-sitemap.xml`
      );
    }

    for (const sm of subSitemaps) {
      try {
        const res = await fetchWithTimeout(sm);
        if (!res.ok) continue;
        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        $('url loc').each((_, el) => urls.add($(el).text().trim()));
      } catch (_) {}
    }
  } catch (err) {
    console.error('[Sync] Failed to fetch sitemap:', err.message);
  }
  return Array.from(urls).filter(u =>
    !u.includes('/product-page/') &&
    !u.includes('/booking-') &&
    !u.includes('/account/') &&
    !u.includes('/members/') &&
    !u.includes('/cart') &&
    !u.includes('/event-details/')
  );
}

// ── Content extraction & chunking (mirrors scraper.js) ───────────────────────

function extractContent(html, url) {
  const $ = cheerio.load(html);
  const title = $('title').text().trim() || $('h1').first().text().trim() || 'Untitled';
  $('script, style, header, footer, nav, iframe, #SITE_HEADER, #SITE_FOOTER, #WIX_ADS').remove();

  let container = $('main').length ? $('main') :
                  $('#PAGES_CONTAINER').length ? $('#PAGES_CONTAINER') : $('body');

  const parts = [];
  container.find('h1,h2,h3,h4,h5,h6,p,li,blockquote').each((_, el) => {
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    if (t && t.length > 5 && !parts.includes(t)) parts.push(t);
  });

  return { title, content: parts.join('\n\n') };
}

function chunkText(text, maxLength = 1000, overlap = 200) {
  if (!text || text.length <= maxLength) return text ? [text] : [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start + overlap) end = lastBreak;
    }
    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlap;
  }
  return chunks.filter(c => c.length > 50);
}

// ── Embedding ─────────────────────────────────────────────────────────────────

let syncEmbedder = null;
async function getEmbedder() {
  if (!syncEmbedder) {
    console.log('[Sync] Loading embedding model...');
    syncEmbedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return syncEmbedder;
}

async function embed(text) {
  const extractor = await getEmbedder();
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

// ── Main sync function ────────────────────────────────────────────────────────

export async function syncNewPosts() {
  console.log('[Sync] Starting incremental sync...');
  const col = await getKnowledgeBase();

  // 1. Get all live site URLs
  const sitemapUrls = await getAllSitemapUrls();
  console.log(`[Sync] Sitemap has ${sitemapUrls.length} URLs.`);

  // 2. Get all URLs already indexed in MongoDB (distinct)
  const existingUrls = new Set(
    await col.distinct('url')
  );
  console.log(`[Sync] MongoDB has ${existingUrls.size} unique URLs already indexed.`);

  // 3. Diff: find URLs in sitemap but not yet in DB
  const newUrls = sitemapUrls.filter(u => !existingUrls.has(u));
  console.log(`[Sync] Found ${newUrls.length} new URL(s) to index.`);

  if (newUrls.length === 0) {
    return { added: 0, message: 'Knowledge base is already up to date.' };
  }

  // 4. Scrape, chunk, embed, and upload each new URL
  let totalChunksAdded = 0;
  for (const [i, url] of newUrls.entries()) {
    console.log(`[Sync] [${i + 1}/${newUrls.length}] Processing: ${url}`);
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) { console.warn(`[Sync] Skipped (HTTP ${res.status}): ${url}`); continue; }

      const html = await res.text();
      const { title, content } = extractContent(html, url);
      if (content.length < 50) { console.warn(`[Sync] Skipped (too short): ${url}`); continue; }

      const chunks = chunkText(content);
      const docs = [];
      for (const chunk of chunks) {
        const embedding = await embed(chunk);
        docs.push({ title, url, text: chunk, embedding, indexedAt: new Date() });
      }

      if (docs.length > 0) {
        await col.insertMany(docs);
        totalChunksAdded += docs.length;
        console.log(`[Sync] ✓ Added ${docs.length} chunks for: ${title}`);
      }

      await delay(800); // Respectful crawl delay
    } catch (err) {
      console.error(`[Sync] Error processing ${url}:`, err.message);
    }
  }

  console.log(`[Sync] Done. Added ${totalChunksAdded} new chunks from ${newUrls.length} new pages.`);
  return {
    added: totalChunksAdded,
    newPages: newUrls.length,
    message: `Successfully indexed ${newUrls.length} new page(s) with ${totalChunksAdded} chunks.`
  };
}
