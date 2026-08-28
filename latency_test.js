import { performance } from 'perf_hooks';
import { MongoClient } from 'mongodb';
import { pipeline } from '@xenova/transformers';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const question = 'who wrote my mother at sixty six';

async function runBenchmark() {
  console.log('==================================================');
  console.log('STARTING RAG BOT LATENCY ANALYSIS');
  console.log('==================================================\n');

  const apiKey = process.env.GEMINI_API_KEY;
  const mongoUri = process.env.MONGODB_URI;

  if (!apiKey || !mongoUri) {
    console.error('Error: GEMINI_API_KEY or MONGODB_URI is missing in .env!');
    process.exit(1);
  }

  // --- Step 0: DB Connect ---
  const dbStart = performance.now();
  console.log('Connecting to MongoDB Atlas...');
  const client = new MongoClient(mongoUri);
  await client.connect();
  const collection = client.db('wix_rag_pipeline').collection('knowledge_base');
  const dbTime = performance.now() - dbStart;
  console.log(`Connected to MongoDB Atlas in: ${dbTime.toFixed(2)}ms\n`);

  // --- Step 1: Model Loading (Warming up local ONNX model) ---
  const modelLoadStart = performance.now();
  console.log('Loading local ONNX embedding model (Xenova/all-MiniLM-L6-v2)...');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const modelLoadTime = performance.now() - modelLoadStart;
  console.log(`Embedding model loaded in: ${modelLoadTime.toFixed(2)}ms\n`);

  const runs = [];
  const iterations = 3;

  for (let run = 1; run <= iterations; run++) {
    console.log(`--- Executing Query Run #${run} ---`);
    const runStart = performance.now();

    // 1. Embedding generation
    const embedStart = performance.now();
    const result = await extractor(question, { pooling: 'mean', normalize: true });
    const embedding = Array.from(result.data);
    const embedTime = performance.now() - embedStart;
    console.log(`  - Local query embedding: ${embedTime.toFixed(2)}ms`);

    // 2. MongoDB Vector Search Retrieval
    const searchStart = performance.now();
    const matches = await collection.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: embedding,
          numCandidates: 100,
          limit: 4
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
    const searchTime = performance.now() - searchStart;
    console.log(`  - MongoDB Atlas Cloud Vector Retrieval: ${searchTime.toFixed(2)}ms (Found ${matches.length} matches)`);

    // 3. Gemini Generation
    const genStart = performance.now();
    const contextText = matches
      .map((match, idx) => `[Source ${idx + 1}] Title: ${match.title}\nURL: ${match.url}\nContent:\n${match.text}`)
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

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const genResult = await model.generateContent(prompt);
    const response = await genResult.response;
    const answer = response.text().trim();
    const genTime = performance.now() - genStart;
    console.log(`  - Gemini 1.5 Flash Generation: ${genTime.toFixed(2)}ms`);

    const totalTime = performance.now() - runStart;
    console.log(`  - Total query turn-around: ${totalTime.toFixed(2)}ms`);
    console.log(`  - Answer: "${answer}"\n`);

    runs.push({
      run,
      embedTime,
      searchTime,
      genTime,
      totalTime
    });
  }

  await client.close();

  console.log('==================================================');
  console.log('BENCHMARK COMPLETE - LATENCY SUMMARY (ms)');
  console.log('==================================================');
  console.log('| Run | Local Embedding | Cloud Search | Gemini 1.5 Flash | Total RAG Time |');
  console.log('|---|---|---|---|---|');
  runs.forEach(r => {
    console.log(`| #${r.run} | ${r.embedTime.toFixed(1)}ms | ${r.searchTime.toFixed(1)}ms | ${r.genTime.toFixed(1)}ms | ${r.totalTime.toFixed(1)}ms |`);
  });
  
  // Calculate averages
  const avgEmbed = runs.reduce((acc, r) => acc + r.embedTime, 0) / iterations;
  const avgSearch = runs.reduce((acc, r) => acc + r.searchTime, 0) / iterations;
  const avgGen = runs.reduce((acc, r) => acc + r.genTime, 0) / iterations;
  const avgTotal = runs.reduce((acc, r) => acc + r.totalTime, 0) / iterations;
  
  console.log(`| **AVG** | **${avgEmbed.toFixed(1)}ms** | **${avgSearch.toFixed(1)}ms** | **${avgGen.toFixed(1)}ms** | **${avgTotal.toFixed(1)}ms** |`);
  console.log('==================================================\n');
  process.exit(0);
}

runBenchmark().catch(console.error);
