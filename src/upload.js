import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const INDEXED_FILE = path.join(DATA_DIR, 'indexed_pages.json');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'wix_rag_pipeline';
const COLLECTION_NAME = 'knowledge_base';
const VECTOR_INDEX_NAME = 'vector_index';

async function main() {
  if (!MONGODB_URI || MONGODB_URI === 'your_mongodb_connection_string_here') {
    console.error('\n[Error] MONGODB_URI is not configured in .env file!');
    console.log('Please add your MongoDB connection string in the following format inside .env:');
    console.log('MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxxx.mongodb.net/?retryWrites=true&w=majority\n');
    process.exit(1);
  }

  if (!fs.existsSync(INDEXED_FILE)) {
    console.error(`\n[Error] Embedded index file not found at ${INDEXED_FILE}`);
    console.log('Please make sure you have generated the local embeddings first using:\n  node src/search.js --index\n');
    process.exit(1);
  }

  console.log('Reading local embedding index...');
  const chunks = JSON.parse(fs.readFileSync(INDEXED_FILE, 'utf-8'));
  console.log(`Loaded ${chunks.length} chunks. Connecting to MongoDB Atlas...`);

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('Connected successfully to MongoDB Atlas!');
    
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);

    // Clear existing collection
    console.log(`Clearing collection "${COLLECTION_NAME}" in database "${DB_NAME}"...`);
    await collection.deleteMany({});
    
    // Batch upload chunks (100 at a time)
    const batchSize = 100;
    console.log(`Uploading ${chunks.length} chunks in batches of ${batchSize}...`);
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      await collection.insertMany(batch);
      console.log(`Uploaded chunks ${i + 1} to ${Math.min(i + batchSize, chunks.length)}...`);
    }

    console.log('\n==================================================');
    console.log('Database upload complete!');
    console.log(`Successfully uploaded ${chunks.length} chunks to collection "${COLLECTION_NAME}".`);
    console.log('==================================================\n');

    console.log('--- ACTION REQUIRED: Setup Atlas Vector Search Index ---');
    console.log('To run semantic vector searches, you must create a Vector Search Index in your MongoDB Atlas UI:');
    console.log(`1. Navigate to your Cluster -> "Search" tab -> click "Create Search Index".`);
    console.log(`2. Select "JSON Editor" under "Atlas Vector Search" (NOT Atlas Search).`);
    console.log(`3. Select database "${DB_NAME}" and collection "${COLLECTION_NAME}".`);
    console.log(`4. Name the index "${VECTOR_INDEX_NAME}".`);
    console.log(`5. Paste the following JSON Index Definition:\n`);
    
    const indexDefinition = {
      fields: [
        {
          numDimensions: 768, // dimension size for gemini-embedding-001
          path: 'embedding',
          similarity: 'cosine',
          type: 'vector'
        }
      ]
    };
    
    console.log(JSON.stringify(indexDefinition, null, 2));
    console.log('\n6. Click "Next" -> "Create Search Index". Wait ~1 minute for status to become "Active".\n');

  } catch (err) {
    console.error('Database operation failed:', err);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
