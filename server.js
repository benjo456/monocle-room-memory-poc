import "dotenv/config";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import multer from "multer";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const app = express();
const port = Number(process.env.PORT || 5177);
const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const openai = hasOpenAIKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const dataDir = path.join(__dirname, "data");
const clipsDir = path.join(dataDir, "clips");
const audioDir = path.join(dataDir, "audio");
const framesDir = path.join(dataDir, "frames");
const metaDir = path.join(dataDir, "meta");
const memoryPath = path.join(dataDir, "memory.jsonl");
const ffmpegPath = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";

await fsp.mkdir(clipsDir, { recursive: true });
await fsp.mkdir(audioDir, { recursive: true });
await fsp.mkdir(framesDir, { recursive: true });
await fsp.mkdir(metaDir, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/clips", express.static(clipsDir));
app.use("/frames", express.static(framesDir));

const storage = multer.diskStorage({
  destination: clipsDir,
  filename: (_req, file, cb) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const originalExt = path.extname(file.originalname || "") || ".webm";
    cb(null, `${stamp}-${randomUUID()}${originalExt}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 80 * 1024 * 1024,
  },
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey,
    transcribeModel: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    chatModel: process.env.CHAT_MODEL || "gpt-4.1-mini",
    memoryPath,
    visionModel: process.env.VISION_MODEL || process.env.CHAT_MODEL || "gpt-4.1-mini",
  });
});

app.get("/api/clips", async (req, res) => {
  const limit = Number(req.query.limit || 40);
  const records = await readMemory();
  res.json(records.slice(-limit).reverse());
});

app.post("/api/upload-clip", upload.single("clip"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing clip file" });
  }

  const clip = {
    id: randomUUID(),
    clipNumber: Number(req.body.clipNumber || 0),
    startedAt: req.body.startedAt || new Date().toISOString(),
    endedAt: req.body.endedAt || new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    filename: req.file.filename,
    path: req.file.path,
    url: `/clips/${req.file.filename}`,
    size: req.file.size,
    mimeType: req.file.mimetype,
  };

  const record = {
    ...clip,
    transcript: "",
    summary: "",
    visualSummary: "",
    frameUrl: "",
    visibleText: "",
    people: [],
    clothing: [],
    objects: [],
    topics: [],
    actionItems: [],
    errors: [],
  };

  const browserTranscript = String(req.body.browserTranscript || "").trim();

  try {
    const transcript = await transcribeClip(req.file.path);
    record.transcript = transcript.text || browserTranscript;
    if (transcript.error) record.errors.push(transcript.error);
    if (!transcript.text && browserTranscript) {
      record.errors.push("Used browser speech-recognition fallback transcript.");
    }
  } catch (error) {
    record.transcript = browserTranscript;
    record.errors.push(error instanceof Error ? error.message : String(error));
    if (browserTranscript) {
      record.errors.push("Used browser speech-recognition fallback transcript.");
    }
  }

  try {
    const visual = await analyzeClipVisuals(req.file.path, record);
    record.visualSummary = visual.visualSummary;
    record.frameUrl = visual.frameUrl;
    record.visibleText = visual.visibleText;
    record.people = visual.people;
    record.clothing = visual.clothing;
    record.objects = visual.objects;
    if (visual.error) record.errors.push(visual.error);
  } catch (error) {
    record.errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const analysis = await summarizeClip(record);
    record.summary = analysis.summary;
    record.topics = analysis.topics;
    record.actionItems = analysis.actionItems;
    if (analysis.error) record.errors.push(analysis.error);
  } catch (error) {
    record.errors.push(error instanceof Error ? error.message : String(error));
  }

  await appendMemory(record);
  await fsp.writeFile(path.join(metaDir, `${record.id}.json`), JSON.stringify(record, null, 2));

  res.json({ record });
});

app.post("/api/ask", async (req, res) => {
  const question = String(req.body.question || "").trim();
  const windowMinutes = Number(req.body.windowMinutes || 10);

  if (!question) {
    return res.status(400).json({ error: "Missing question" });
  }

  const records = await recentRecords(windowMinutes);
  const answer = await answerQuestion(question, records, windowMinutes);
  res.json(answer);
});

app.post("/api/backfill-visuals", async (req, res) => {
  const limit = Number(req.body?.limit || 20);
  const records = await readMemory();
  const candidates = records
    .filter((record) => !record.frameUrl && record.path)
    .slice(-limit);

  const results = [];
  for (const record of candidates) {
    try {
      await fsp.access(record.path);
      const visual = await analyzeClipVisuals(record.path, record);
      record.visualSummary = visual.visualSummary;
      record.frameUrl = visual.frameUrl;
      record.visibleText = visual.visibleText;
      record.people = visual.people;
      record.clothing = visual.clothing;
      record.objects = visual.objects;
      if ((!record.summary || record.summary.startsWith("No speech transcript")) && record.visualSummary) {
        record.summary = record.visualSummary;
      }
      if (visual.error) record.errors = [...(record.errors || []), visual.error];
      await fsp.writeFile(path.join(metaDir, `${record.id}.json`), JSON.stringify(record, null, 2));
      results.push({ id: record.id, clipNumber: record.clipNumber, ok: true });
    } catch (error) {
      record.errors = [...(record.errors || []), error instanceof Error ? error.message : String(error)];
      results.push({ id: record.id, clipNumber: record.clipNumber, ok: false });
    }
  }

  await writeMemory(records);
  res.json({
    ok: true,
    updated: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  });
});

app.post("/api/reset", async (_req, res) => {
  await fsp.writeFile(memoryPath, "");
  await Promise.all([
    clearDirectoryFiles(clipsDir),
    clearDirectoryFiles(audioDir),
    clearDirectoryFiles(framesDir),
    clearDirectoryFiles(metaDir),
  ]);
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Monocle POC running at http://localhost:${port}`);
  console.log(hasOpenAIKey ? "OpenAI API key detected." : "OPENAI_API_KEY not set; clips will record but not transcribe.");
});

async function transcribeClip(filePath) {
  if (!openai) {
    return { text: "", error: "OPENAI_API_KEY is not set, so this clip was saved without transcription." };
  }

  const audioPath = await normalizeAudioForTranscription(filePath);
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    });

    return { text: (response.text || "").trim() };
  } finally {
    await fsp.rm(audioPath, { force: true });
  }
}

async function normalizeAudioForTranscription(filePath) {
  const outputPath = path.join(audioDir, `${randomUUID()}.wav`);
  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outputPath,
    ]);
    return outputPath;
  } catch (error) {
    await fsp.rm(outputPath, { force: true });
    const details = error?.stderr || error?.message || String(error);
    throw new Error(`Could not extract audio from clip: ${details.trim()}`);
  }
}

async function analyzeClipVisuals(filePath, record) {
  const frame = await extractRepresentativeFrame(filePath, record.id);

  if (!openai) {
    return {
      visualSummary: "",
      frameUrl: frame.url,
      visibleText: "",
      people: [],
      clothing: [],
      objects: [],
      error: "OPENAI_API_KEY is not set, so this clip frame was saved without visual analysis.",
    };
  }

  const imageBase64 = await fsp.readFile(frame.path, "base64");
  const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
  const response = await openai.responses.create({
    model: process.env.VISION_MODEL || process.env.CHAT_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Analyze this representative webcam frame from a room-memory clip. Return compact JSON only. Describe observable visual facts; do not identify people by name unless the transcript already names them. Include clothing, visible text/slides, objects, and room context when visible.",
          },
          {
            type: "input_image",
            image_url: imageUrl,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "clip_visuals",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            visualSummary: { type: "string" },
            visibleText: { type: "string" },
            people: { type: "array", items: { type: "string" } },
            clothing: { type: "array", items: { type: "string" } },
            objects: { type: "array", items: { type: "string" } },
          },
          required: ["visualSummary", "visibleText", "people", "clothing", "objects"],
        },
      },
    },
  });

  const visual = JSON.parse(response.output_text);
  return {
    ...visual,
    frameUrl: frame.url,
  };
}

async function extractRepresentativeFrame(filePath, clipId) {
  const outputPath = path.join(framesDir, `${clipId}.jpg`);
  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vf",
      "thumbnail,scale='min(960,iw)':-2",
      "-frames:v",
      "1",
      outputPath,
    ]);

    return {
      path: outputPath,
      url: `/frames/${path.basename(outputPath)}`,
    };
  } catch (error) {
    await fsp.rm(outputPath, { force: true });
    const details = error?.stderr || error?.message || String(error);
    throw new Error(`Could not extract video frame from clip: ${details.trim()}`);
  }
}

async function summarizeClip(record) {
  if (!openai) {
    if (record.transcript) {
      return localTranscriptAnalysis(record.transcript);
    }

    return {
      summary: "",
      topics: [],
      actionItems: [],
      error: "OPENAI_API_KEY is not set, so this clip was saved without summary analysis.",
    };
  }

  if (!record.transcript) {
    if (record.visualSummary) {
      return {
        summary: record.visualSummary,
        topics: [...new Set([...(record.objects || []), ...(record.clothing || [])])]
          .map((topic) => topic.toLowerCase())
          .slice(0, 6),
        actionItems: [],
      };
    }

    return {
      summary: "No speech transcript was detected for this 30-second clip.",
      topics: [],
      actionItems: [],
    };
  }

  const response = await openai.responses.create({
    model: process.env.CHAT_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "You summarize 30-second room-recording clips for a hackathon prototype. Return compact JSON only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Summarize this clip.",
          schema: {
            summary: "one concise sentence",
            topics: ["3-6 lowercase topic tags"],
            actionItems: ["explicit actions only"],
          },
          clip: {
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            transcript: record.transcript,
            visualSummary: record.visualSummary,
            visibleText: record.visibleText,
            people: record.people,
            clothing: record.clothing,
            objects: record.objects,
          },
        }),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "clip_summary",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            topics: { type: "array", items: { type: "string" } },
            actionItems: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "topics", "actionItems"],
        },
      },
    },
  });

  return JSON.parse(response.output_text);
}

async function answerQuestion(question, records, windowMinutes) {
  if (!records.length) {
    return {
      answer: `I do not have any recorded clips in the last ${windowMinutes} minutes yet.`,
      citations: [],
    };
  }

  const context = records.map((record) => ({
    clipNumber: record.clipNumber,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    transcript: record.transcript,
    summary: record.summary,
    visualSummary: record.visualSummary,
    visibleText: record.visibleText,
    people: record.people,
    clothing: record.clothing,
    objects: record.objects,
    frameUrl: record.frameUrl,
    topics: record.topics,
    actionItems: record.actionItems,
    url: record.url,
    errors: record.errors,
  }));

  if (!openai) {
    const fallback = context
      .slice(-6)
      .map((clip) => {
        const clock = `${new Date(clip.startedAt).toLocaleTimeString()}-${new Date(clip.endedAt).toLocaleTimeString()}`;
        return `Clip ${clip.clipNumber} (${clock}): ${
          clip.summary || clip.transcript || "No transcript yet."
        }`;
      })
      .filter(Boolean)
      .join("\n");

    return {
      answer:
        fallback
          ? `OPENAI_API_KEY is not set, so this is a simple transcript-based answer.\n\n${fallback}`
          : "The clips were saved, but OPENAI_API_KEY is not set and no browser transcript was captured yet.",
      citations: context.slice(-6).map(toCitation),
    };
  }

  const response = await openai.responses.create({
    model: process.env.CHAT_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "Answer questions about a live room recording using only the provided clip memories. Use transcripts for spoken content and visual summaries for webcam/video questions such as clothing, objects, slides, visible text, people, or room state. Treat adjacent clips as one continuous timeline, stitch partial thoughts across clip boundaries, and deduplicate repeated wording from overlapping clips. Do not treat a clip boundary as a topic change by itself. Be concise. Cite clip numbers and rough times when useful. If the answer is not in the context, say so.",
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          windowMinutes,
          clipMemories: context,
        }),
      },
    ],
  });

  return {
    answer: response.output_text.trim(),
    citations: context.slice(-8).map(toCitation),
  };
}

async function recentRecords(windowMinutes) {
  const records = await readMemory();
  const since = Date.now() - windowMinutes * 60 * 1000;
  return records.filter((record) => Date.parse(record.endedAt || record.uploadedAt) >= since);
}

async function readMemory() {
  try {
    const body = await fsp.readFile(memoryPath, "utf8");
    return body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function appendMemory(record) {
  await fsp.appendFile(memoryPath, `${JSON.stringify(record)}\n`);
}

async function writeMemory(records) {
  await fsp.writeFile(
    memoryPath,
    records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
  );
}

async function clearDirectoryFiles(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name !== ".gitkeep")
      .map((entry) => fsp.rm(path.join(directory, entry.name), { force: true })),
  );
}

function toCitation(record) {
  return {
    clipNumber: record.clipNumber,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    url: record.url,
    frameUrl: record.frameUrl,
    summary: record.summary,
    visualSummary: record.visualSummary,
  };
}

function localTranscriptAnalysis(transcript) {
  const cleaned = transcript.replace(/\s+/g, " ").trim();
  const summary = cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
  const topics = extractKeywords(cleaned);
  const actionItems = cleaned
    .split(/[.!?]/)
    .map((line) => line.trim())
    .filter((line) => /\b(action|todo|to do|need to|should|follow up|next)\b/i.test(line))
    .slice(0, 4);

  return {
    summary: summary || "Browser speech recognition produced an empty transcript.",
    topics,
    actionItems,
  };
}

function extractKeywords(text) {
  const stop = new Set([
    "about",
    "after",
    "again",
    "also",
    "because",
    "been",
    "being",
    "could",
    "from",
    "have",
    "into",
    "just",
    "like",
    "more",
    "that",
    "their",
    "there",
    "this",
    "with",
    "would",
    "your",
  ]);

  const counts = new Map();
  for (const word of text.toLowerCase().match(/\b[a-z][a-z0-9-]{3,}\b/g) || []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);
}
