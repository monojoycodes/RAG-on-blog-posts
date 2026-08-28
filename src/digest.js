/**
 * digest.js — Weekly AI-powered analytics digest sent via email.
 *
 * Required .env variables:
 *   GMAIL_APP_PASSWORD = xxxx xxxx xxxx xxxx  (Gmail App Password for monojoycodes@gmail.com)
 *
 * Sender:     monojoycodes@gmail.com
 * Recipients: himonotosh@gmail.com, monojoydey9@gmail.com
 *
 * How to get a Gmail App Password:
 *   1. Sign into monojoycodes@gmail.com
 *   2. Go to https://myaccount.google.com/security
 *   3. Enable 2-Step Verification if not already on
 *   4. Search "App Passwords" → Select app: Mail → Generate
 *   5. Copy the 16-character code → paste as GMAIL_APP_PASSWORD in .env
 *
 * Security note: App Passwords grant SMTP email access ONLY.
 * They cannot access Google Photos, Drive, or any other Google service.
 */

import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRecentLogs, getStats } from './logger.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Generate a Gemini-powered digest summary from recent query logs.
 */
async function generateDigestSummary(logs, stats) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Prepare a condensed view of recent queries for Gemini
  const sampleQueries = logs
    .slice(0, 50)
    .map(l => `Q: ${l.question} | Fallback: ${l.isFallback ? 'YES' : 'no'}`)
    .join('\n');

  const prompt = `You are an analytics assistant reviewing chatbot usage data for an English education website called "English With A Difference" (englishwithadifference.com). 

Here are the usage stats for the past 7 days:
- Total queries this week: ${stats.totalWeek}
- Total queries today: ${stats.totalToday}
- Fallback responses (questions the bot couldn't answer): ${stats.fallbackCount}
- Top questions asked:
${stats.topQuestions.map((q, i) => `  ${i + 1}. "${q._id}" (asked ${q.count} times)`).join('\n')}

Sample of recent questions:
${sampleQueries}

Please provide a concise analytics report with:
1. **Theme Summary**: What topics are students most interested in? (2-3 sentences)
2. **Knowledge Gaps**: Based on fallback responses, what content is missing from the website? List as bullet points.
3. **Top 5 Questions This Week**: The most important questions asked.
4. **Action Items**: Specific recommendations for the website owner to improve the chatbot's coverage. (bullet points)
5. **Response Quality Note**: Any patterns in how the bot is answering (good or bad)?

Keep the report concise, data-driven, and actionable. Format in plain HTML for email.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/**
 * Send the digest email using Gmail SMTP.
 */
async function sendEmail(subject, htmlBody) {
  const pass = process.env.GMAIL_APP_PASSWORD;
  const sender = 'monojoycodes@gmail.com';
  const recipients = 'himonotosh@gmail.com, monojoydey9@gmail.com';

  if (!pass) {
    throw new Error('GMAIL_APP_PASSWORD not set in .env — see digest.js for setup instructions');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: sender, pass }
  });

  await transporter.sendMail({
    from: `"English AI Tutor Analytics" <${sender}>`,
    to: recipients,
    subject,
    html: `
      <div style="font-family: Georgia, serif; max-width: 680px; margin: 0 auto; color: #1a1a1a;">
        <div style="background: linear-gradient(135deg, #7B1C1C, #5a1414); padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 22px;">✦ English AI Tutor — Weekly Insights</h1>
          <p style="color: rgba(255,255,255,0.7); margin: 6px 0 0; font-size: 13px;">englishwithadifference.com · Automated Analytics Report</p>
        </div>
        <div style="background: #fdf6ee; padding: 24px; border: 1px solid #e4d5c5; border-top: none; border-radius: 0 0 8px 8px;">
          ${htmlBody}
        </div>
        <p style="text-align: center; color: #888; font-size: 11px; margin-top: 16px;">
          This report was generated automatically by your RAG chatbot pipeline.<br>
          Sent from monojoycodes@gmail.com to ${recipients}.
        </p>
      </div>
    `
  });

  console.log(`[Digest] Email sent to: ${recipients}`);
}

/**
 * Main digest function — call this from the /digest endpoint.
 */
export async function runDigest() {
  console.log('[Digest] Starting weekly digest generation...');

  const [logs, stats] = await Promise.all([
    getRecentLogs(7, 200),
    getStats()
  ]);

  if (logs.length === 0) {
    console.log('[Digest] No queries in the last 7 days. Skipping digest.');
    return { skipped: true, reason: 'No queries in the last 7 days' };
  }

  console.log(`[Digest] Summarising ${logs.length} queries with Gemini...`);
  const summary = await generateDigestSummary(logs, stats);

  const subject = `✦ English AI Tutor Weekly Report — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  await sendEmail(subject, summary);

  return {
    success: true,
    queriesAnalysed: logs.length,
    stats
  };
}
