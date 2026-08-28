import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const BASE_URL = 'https://www.englishwithadifference.com';
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const OUT_FILE = path.join(DATA_DIR, 'scraped_pages.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Delay utility to prevent rate-limiting
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to fetch text from a URL with timeout
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        ...options.headers,
      }
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Fetch all sub-sitemap URLs from main sitemap
async function getSubSitemaps(mainSitemapUrl) {
  console.log(`Fetching main sitemap: ${mainSitemapUrl}`);
  try {
    const res = await fetchWithTimeout(mainSitemapUrl);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    
    // Find all loc elements inside sitemap tags
    const sitemaps = [];
    $('sitemap loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) sitemaps.push(loc);
    });
    
    // Fallbacks if no sub-sitemaps found in index
    if (sitemaps.length === 0) {
      console.log('No sub-sitemaps found in main sitemap. Using fallbacks.');
      return [
        `${BASE_URL}/pages-sitemap.xml`,
        `${BASE_URL}/blog-posts-sitemap.xml`,
        `${BASE_URL}/online-programs-sitemap.xml`
      ];
    }
    
    return sitemaps;
  } catch (err) {
    console.error(`Error fetching main sitemap: ${err.message}. Using default sub-sitemap list.`);
    return [
      `${BASE_URL}/pages-sitemap.xml`,
      `${BASE_URL}/blog-posts-sitemap.xml`,
      `${BASE_URL}/online-programs-sitemap.xml`
    ];
  }
}

// Fetch all page URLs from a sub-sitemap
async function getPageUrlsFromSitemap(sitemapUrl) {
  console.log(`Fetching sub-sitemap: ${sitemapUrl}`);
  try {
    const res = await fetchWithTimeout(sitemapUrl);
    if (!res.ok) {
      console.log(`Failed to fetch sitemap ${sitemapUrl}: status ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = [];
    $('url loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) urls.push(loc);
    });
    return urls;
  } catch (err) {
    console.error(`Error parsing sitemap ${sitemapUrl}: ${err.message}`);
    return [];
  }
}

// Clean and extract readable content from HTML
function extractContentFromHtml(html, url) {
  const $ = cheerio.load(html);

  // Get metadata
  const title = $('title').text().trim() || $('h1').first().text().trim() || 'Untitled';
  const description = $('meta[name="description"]').attr('content')?.trim() || '';

  // Clean HTML: Remove script, style, nav, header, footer, ads, iframe
  $('script').remove();
  $('style').remove();
  $('header').remove();
  $('footer').remove();
  $('nav').remove();
  $('iframe').remove();
  $('#SITE_HEADER').remove();
  $('#SITE_FOOTER').remove();
  $('#WIX_ADS').remove();
  $('.wix-ads').remove();
  
  // Extract text from headers, paragraphs, and list items
  const contentParts = [];
  
  // Target content container specifically if possible
  // Wix often houses main content inside main or role="main" or pages container
  let container = $('main');
  if (container.length === 0) {
    container = $('#PAGES_CONTAINER');
  }
  if (container.length === 0) {
    container = $('body');
  }

  // Iterate over text blocks in order of appearance
  container.find('h1, h2, h3, h4, h5, h6, p, li, blockquote').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text && text.length > 5) {
      // Avoid duplicate texts and navigation noise
      if (!contentParts.includes(text)) {
        contentParts.push(text);
      }
    }
  });

  const fullText = contentParts.join('\n\n');
  return {
    url,
    title,
    description,
    content: fullText,
    charCount: fullText.length,
    scrapedAt: new Date().toISOString()
  };
}

// Main scrape function
async function scrapeWebsite() {
  console.log('--- Starting Website Scraper ---');
  
  // 1. Get sub-sitemaps
  const subSitemaps = await getSubSitemaps(SITEMAP_URL);
  console.log(`Discovered ${subSitemaps.length} sub-sitemaps.`);
  
  // 2. Discover all page URLs
  const uniqueUrls = new Set();
  for (const sitemap of subSitemaps) {
    const urls = await getPageUrlsFromSitemap(sitemap);
    urls.forEach(url => uniqueUrls.add(url));
  }
  
  // Also add some known fallbacks/defaults just in case sitemaps are empty
  const defaultPages = [
    BASE_URL,
    `${BASE_URL}/post`
  ];
  defaultPages.forEach(url => uniqueUrls.add(url));

  const allUrls = Array.from(uniqueUrls).filter(url => {
    const isExcluded = url.includes('/product-page/') || 
                       url.includes('/booking-') || 
                       url.includes('/account/') || 
                       url.includes('/members/') || 
                       url.includes('/cart') ||
                       url.includes('/event-details/');
    return !isExcluded;
  });
  console.log(`Total filtered URLs to scrape: ${allUrls.length}`);
  
  // Filter and show summary of blog posts vs other pages
  const blogUrls = allUrls.filter(url => url.includes('/post'));
  const normalUrls = allUrls.filter(url => !url.includes('/post'));
  
  console.log(`- Blog URLs (Lessons): ${blogUrls.length}`);
  console.log(`- General URLs (Info): ${normalUrls.length}`);

  // 3. Crawl pages and extract content
  const crawledData = [];
  const CONCURRENCY = 10;

  async function scrapeWorker(url, index) {
    console.log(`[${index + 1}/${allUrls.length}] Scraping: ${url}`);
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        console.error(`  Error for ${url}: HTTP status ${res.status}`);
        return;
      }
      const html = await res.text();
      const pageData = extractContentFromHtml(html, url);
      
      if (pageData.content.length > 50) {
        crawledData.push(pageData);
        console.log(`  Success! ${url} -> ${pageData.charCount} chars`);
      } else {
        console.log(`  Skipped (short): ${url}`);
      }
    } catch (err) {
      console.error(`  Failed ${url}: ${err.message}`);
    }
  }

  // Run in chunks of CONCURRENCY size
  for (let i = 0; i < allUrls.length; i += CONCURRENCY) {
    const batch = allUrls.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((url, batchIndex) => scrapeWorker(url, i + batchIndex)));
    // Delay between batches
    await delay(1000);
  }
  
  // 4. Save results to JSON file
  fs.writeFileSync(OUT_FILE, JSON.stringify(crawledData, null, 2), 'utf-8');
  console.log(`\nScrape completed! Saved ${crawledData.length} pages to ${OUT_FILE}`);
}

// Execute
scrapeWebsite().catch(err => {
  console.error('Fatal scrape error:', err);
  process.exit(1);
});
