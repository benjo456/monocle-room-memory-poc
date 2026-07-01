#!/usr/bin/env node
import "dotenv/config";

const args = process.argv.slice(2);
const options = parseArgs(args);
const rawQuestion = options.question || args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
const question = normalizeQuestion(rawQuestion);

if (!question) {
  console.error('Usage: npm run ask:monocle -- "what was that last presentation about?"');
  console.error('Also accepts: npm run ask:monocle -- "/monocle what was that last presentation about?"');
  process.exit(2);
}

const baseUrl =
  process.env.MONOCLE_URL || process.env.ROOM_CHRONICLE_URL || "http://localhost:5177";
const windowMinutes = Number(
  options.minutes ||
    process.env.MONOCLE_WINDOW_MINUTES ||
    process.env.ROOM_CHRONICLE_WINDOW_MINUTES ||
    10,
);

try {
  const response = await fetch(`${baseUrl}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, windowMinutes }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printAnswer(payload);
  }
} catch (error) {
  console.error(`Monocle query failed: ${error.message}`);
  console.error(`Make sure the recorder server is running at ${baseUrl}.`);
  process.exit(1);
}

function printAnswer(payload) {
  console.log(payload.answer || "No answer returned.");

  const citations = payload.citations || [];
  if (!citations.length) return;

  console.log("\nRecent clips used:");
  for (const clip of citations.slice(0, 6)) {
    const start = formatClock(clip.startedAt);
    const end = formatClock(clip.endedAt);
    const summary = clip.summary || clip.visualSummary ? ` - ${clip.summary || clip.visualSummary}` : "";
    console.log(`- Clip ${clip.clipNumber} (${start}-${end})${summary}`);
  }
}

function parseArgs(values) {
  const parsed = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      parsed.json = true;
    } else if (value === "--minutes" || value === "-m") {
      parsed.minutes = values[index + 1];
      index += 1;
    } else if (value === "--question" || value === "-q") {
      parsed.question = values[index + 1];
      index += 1;
    }
  }

  return parsed;
}

function normalizeQuestion(value) {
  return String(value || "")
    .trim()
    .replace(/^\/monocle\b\s*/i, "")
    .trim();
}

function formatClock(value) {
  if (!value) return "--:--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
