/**
 * logger.js — Logs every RAG query + response to MongoDB for analytics.
 * Collection: wix_rag_pipeline.query_logs
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

let logClient = null;

async function getLogCollection() {
  if (!logClient) {
    logClient = new MongoClient(process.env.MONGODB_URI);
    await logClient.connect();
  }
  return logClient.db('wix_rag_pipeline').collection('query_logs');
}

/**
 * Log a completed RAG query to MongoDB.
 * Non-fatal — will never crash the main server.
 */
export async function logQuery({ question, answer, sources, pageUrl, durationMs }) {
  try {
    const col = await getLogCollection();
    await col.insertOne({
      question: question.trim(),
      answer,
      sources: sources || [],
      pageUrl: pageUrl || null,
      durationMs: Math.round(durationMs),
      isFallback: answer.includes("couldn't find specific information"),
      timestamp: new Date()
    });
  } catch (err) {
    // Log to console but never throw — analytics must never break the chatbot
    console.error('[Logger] Failed to log query:', err.message);
  }
}

/**
 * Fetch recent logs for the admin dashboard or digest.
 * @param {number} days - How many days back to fetch
 * @param {number} limit - Max number of records to return
 */
export async function getRecentLogs(days = 7, limit = 500) {
  try {
    const col = await getLogCollection();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return await col
      .find({ timestamp: { $gte: since } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.error('[Logger] Failed to fetch logs:', err.message);
    return [];
  }
}

/**
 * Get aggregate stats for the dashboard.
 */
export async function getStats() {
  try {
    const col = await getLogCollection();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalToday, totalWeek, totalAll, fallbackCount, topQuestions] = await Promise.all([
      col.countDocuments({ timestamp: { $gte: todayStart } }),
      col.countDocuments({ timestamp: { $gte: weekStart } }),
      col.countDocuments({}),
      col.countDocuments({ isFallback: true, timestamp: { $gte: weekStart } }),
      col.aggregate([
        { $match: { timestamp: { $gte: weekStart } } },
        { $group: { _id: '$question', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]).toArray()
    ]);

    return { totalToday, totalWeek, totalAll, fallbackCount, topQuestions };
  } catch (err) {
    console.error('[Logger] Failed to get stats:', err.message);
    return { totalToday: 0, totalWeek: 0, totalAll: 0, fallbackCount: 0, topQuestions: [] };
  }
}
