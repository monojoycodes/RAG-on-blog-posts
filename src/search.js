import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

let mongoClient = null;

async function getMongoCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
  }
  return mongoClient.db('wix_rag_pipeline').collection('knowledge_base');
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SCRAPED_FILE = path.join(DATA_DIR, 'scraped_pages.json');
const INDEXED_FILE = path.join(DATA_DIR, 'indexed_pages.json');

// Singleton embedder to avoid reloading the model multiple times
let embedderInstance = null;

async function getEmbedder() {
  if (!embedderInstance) {
    console.log('Initializing local embedding model (Xenova/all-MiniLM-L6-v2)...');
    // Using ONNX model under the hood
    embedderInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderInstance;
}

// Helper to calculate cosine similarity (used in local search fallback)
export function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Chunk text by paragraph and length constraints with overlap
export function chunkText(text, maxLength = 1000, overlap = 200) {
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  
  const chunks = [];
  let startIndex = 0;
  
  while (startIndex < text.length) {
    let endIndex = startIndex + maxLength;
    
    if (endIndex < text.length) {
      const lastPeriod = text.lastIndexOf('. ', endIndex);
      if (lastPeriod > startIndex + maxLength * 0.6) {
        endIndex = lastPeriod + 1;
      } else {
        const lastNewline = text.lastIndexOf('\n', endIndex);
        if (lastNewline > startIndex + maxLength * 0.5) {
          endIndex = lastNewline;
        } else {
          const lastSpace = text.lastIndexOf(' ', endIndex);
          if (lastSpace > startIndex + maxLength * 0.5) {
            endIndex = lastSpace;
          }
        }
      }
    }
    
    const chunk = text.substring(startIndex, endIndex).trim();
    if (chunk.length > 20) {
      chunks.push(chunk);
    }
    
    startIndex = endIndex - overlap;
    if (startIndex >= text.length - overlap) {
      break;
    }
  }
  
  return chunks;
}

// Generate embeddings and index pages locally
export async function indexPages() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(SCRAPED_FILE)) {
    throw new Error(`Scraped data file not found at ${SCRAPED_FILE}. Please run npm run scrape first.`);
  }

  console.log('Loading scraped pages...');
  const pages = JSON.parse(fs.readFileSync(SCRAPED_FILE, 'utf-8'));
  console.log(`Loaded ${pages.length} pages. Generating chunks...`);

  const extractor = await getEmbedder();

  const indexedChunks = [];
  let totalChunks = 0;

  // Process pages and create chunks
  for (const page of pages) {
    const chunks = chunkText(page.content, 1000, 200);
    
    for (let i = 0; i < chunks.length; i++) {
      indexedChunks.push({
        id: `chunk_${totalChunks++}`,
        url: page.url,
        title: page.title,
        description: page.description,
        text: chunks[i],
        embedding: null
      });
    }
  }

  console.log(`\nGenerated ${indexedChunks.length} chunks. Generating embeddings locally using all-MiniLM-L6-v2...`);
  const startTime = Date.now();

  for (const chunk of indexedChunks) {
    // Log progress every 50 chunks
    const chunkNum = parseInt(chunk.id.split('_')[1]) + 1;
    if (chunkNum % 50 === 0 || chunkNum === indexedChunks.length) {
      console.log(`Embedded ${chunkNum}/${indexedChunks.length} chunks...`);
    }

    try {
      // Run the local model inference
      const result = await extractor(chunk.text, { pooling: 'mean', normalize: true });
      chunk.embedding = Array.from(result.data);
    } catch (err) {
      console.error(`Failed to embed chunk ${chunk.id}: ${err.message}`);
    }
  }

  // Filter out any chunks that failed to embed
  const validIndexedChunks = indexedChunks.filter(c => c.embedding !== null);
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  fs.writeFileSync(INDEXED_FILE, JSON.stringify(validIndexedChunks, null, 2), 'utf-8');
  console.log(`\nIndexing complete! Embedded ${validIndexedChunks.length}/${indexedChunks.length} chunks in ${elapsed}s.`);
  console.log(`Index saved to ${INDEXED_FILE}`);
}

// Search index for closest matches (utilizes MongoDB Atlas or falls back to local index)
export async function searchIndex(query, limit = 5) {
  // Embed query locally
  const extractor = await getEmbedder();
  const queryResult = await extractor(query, { pooling: 'mean', normalize: true });
  const queryEmbedding = Array.from(queryResult.data);

  // 1. If MongoDB URI is configured, perform Vector Search on MongoDB Atlas
  if (process.env.MONGODB_URI && process.env.MONGODB_URI !== 'your_mongodb_connection_string_here') {
    try {
      const collection = await getMongoCollection();
      
      // Perform Atlas Vector Search using aggregation pipeline
      const results = await collection.aggregate([
        {
          $vectorSearch: {
            index: 'vector_index',
            path: 'embedding',
            queryVector: queryEmbedding,
            numCandidates: 100,
            limit: limit
          }
        },
        {
          $project: {
            _id: 0,
            title: 1,
            url: 1,
            text: 1,
            score: { $meta: 'vectorSearchScore' }
          }
        }
      ]).toArray();

      return results;
    } catch (err) {
      console.warn('MongoDB Atlas Vector Search failed. Falling back to local search. Error:', err.message);
    }
  }

  // 2. Local fallback if MongoDB is not configured or fails
  if (!fs.existsSync(INDEXED_FILE)) {
    throw new Error(`Indexed data file not found at ${INDEXED_FILE}. Please run indexing first (node src/search.js --index).`);
  }

  const indexedChunks = JSON.parse(fs.readFileSync(INDEXED_FILE, 'utf-8'));
  
  // Calculate similarity
  const results = indexedChunks.map(chunk => {
    const score = cosineSimilarity(queryEmbedding, chunk.embedding);
    return {
      title: chunk.title,
      url: chunk.url,
      text: chunk.text,
      score: score
    };
  });

  // Sort and return top matches
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--index')) {
    try {
      await indexPages();
      process.exit(0);
    } catch (err) {
      console.error('Indexing failed:', err.message);
      process.exit(1);
    }
  } else if (args.length > 0) {
    const query = args.join(' ');
    console.log(`Searching for: "${query}"...\n`);
    try {
      const matches = await searchIndex(query);
      matches.forEach((match, index) => {
        console.log(`[${index + 1}] Score: ${match.score.toFixed(4)} | Title: ${match.title}`);
        console.log(`URL: ${match.url}`);
        console.log(`Snippet: ${match.text.substring(0, 200)}...`);
        console.log('-'.repeat(40));
      });
      process.exit(0);
    } catch (err) {
      console.error('Search failed:', err.message);
      process.exit(1);
    }
  } else {
    console.log('Usage:');
    console.log('  node src/search.js --index      - Build local embedding index');
    console.log('  node src/search.js "your query" - Search the local index');
  }
}

// Run if called directly
if (process.argv[1] && (process.argv[1].endsWith('search.js') || process.argv[1].includes('src/search.js') || process.argv[1].includes('src\\search.js'))) {
  main();
}
