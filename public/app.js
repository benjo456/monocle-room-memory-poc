const preview = document.querySelector("#preview");
const livePanel = document.querySelector(".live-panel");
const apiStatus = document.querySelector("#api-status");
const startButton = document.querySelector("#start");
const togglePreviewButton = document.querySelector("#toggle-preview");
const clipNowButton = document.querySelector("#clip-now");
const stopButton = document.querySelector("#stop");
const clipSecondsInput = document.querySelector("#clip-seconds");
const recordingDot = document.querySelector("#recording-dot");
const recordingState = document.querySelector("#recording-state");
const clipCount = document.querySelector("#clip-count");
const countdown = document.querySelector("#countdown");
const clipsEl = document.querySelector("#clips");
const askForm = document.querySelector("#ask-form");
const questionInput = document.querySelector("#question");
const answerEl = document.querySelector("#answer");
const refreshButton = document.querySelector("#refresh");
const clearMemoryButton = document.querySelector("#clear-memory");
const navItems = document.querySelectorAll(".nav-item");
const wordCloudEl = document.querySelector("#word-cloud");
const brainMeterEl = document.querySelector("#brain-meter");
const brainCanvas = document.querySelector("#brain-canvas");

let stream;
let clipNumber = 0;
let countdownTimer;
let nextChunkAt;
let isUploading = false;
let isRecording = false;
let activeSegments = new Set();
let speechRecognition;
let pendingSpeechText = "";
let shouldRunSpeechRecognition = false;
let latestClips = [];
let brainRenderTimer;
let conversationSnippets = loadConversationSnippets();
let brainAnimationFrame;
let neuralNodes = [];
let lastBrainWordSignature = "";
let isPreviewHidden = localStorage.getItem("monoclePreviewHidden") === "true";

await loadStatus();
await refreshClips();
startBrainLoop();
startBrainCanvas();
updatePreviewVisibility();

startButton.addEventListener("click", startRecording);
togglePreviewButton.addEventListener("click", togglePreview);
clipNowButton.addEventListener("click", clipNow);
stopButton.addEventListener("click", stopRecording);
refreshButton.addEventListener("click", refreshClips);
clearMemoryButton.addEventListener("click", clearMemory);
navItems.forEach((item) => item.addEventListener("click", () => window.setTimeout(syncNavFromHash, 0)));
window.addEventListener("hashchange", syncNavFromHash);
syncNavFromHash();

document.querySelectorAll("[data-question]").forEach((button) => {
  button.addEventListener("click", () => {
    questionInput.value = button.dataset.question;
    askForm.requestSubmit();
  });
});

askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  answerEl.classList.remove("empty");
  answerEl.textContent = "Thinking over recent room memory...";

  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, windowMinutes: 10 }),
  });

  const payload = await response.json();
  if (!response.ok) {
    answerEl.textContent = payload.error || "Question failed.";
    return;
  }

  const citations = (payload.citations || [])
    .slice(0, 4)
    .map((clip) => `Clip ${clip.clipNumber}: ${formatClock(clip.startedAt)}-${formatClock(clip.endedAt)}`)
    .join("\n");

  answerEl.textContent = citations ? `${payload.answer}\n\nRecent clips:\n${citations}` : payload.answer;
  rememberConversation(question, payload.answer);
  renderBrain(latestClips);
});

async function loadStatus() {
  const response = await fetch("/api/status");
  const status = await response.json();
  const keyStatus = status.hasOpenAIKey
    ? "Connected - audio + vision"
    : "Local capture - no model key";
  apiStatus.textContent = keyStatus;
}

function syncNavFromHash() {
  const hash = window.location.hash || "#capture";
  const activeHash = ["#ask", "#memory", "#brain"].includes(hash) ? hash : "#capture";

  navItems.forEach((item) => {
    item.classList.toggle("active", item.getAttribute("href") === activeHash);
  });

  document.body.classList.toggle("brain-mode", activeHash === "#brain");
  if (activeHash === "#brain") {
    window.requestAnimationFrame(() => {
      document.querySelector("#brain")?.scrollIntoView({ block: "start" });
    });
  }
}

function togglePreview() {
  isPreviewHidden = !isPreviewHidden;
  localStorage.setItem("monoclePreviewHidden", String(isPreviewHidden));
  updatePreviewVisibility();
}

function updatePreviewVisibility() {
  livePanel.classList.toggle("preview-hidden", isPreviewHidden);
  togglePreviewButton.textContent = isPreviewHidden ? "Show video" : "Hide video";
  togglePreviewButton.setAttribute("aria-pressed", String(isPreviewHidden));
}

async function startRecording() {
  if (isRecording) return;

  const clipMs = getClipMs();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    },
  });

  preview.srcObject = stream;
  clipNumber = 0;
  isRecording = true;
  activeSegments = new Set();
  nextChunkAt = Date.now() + clipMs;

  startSpeechRecognition();
  startSegment();
  document.body.classList.add("is-recording");
  recordingDot.classList.add("active");
  recordingState.textContent = "Recording";
  startButton.disabled = true;
  clipNowButton.disabled = false;
  stopButton.disabled = false;
  clipSecondsInput.disabled = true;
  startCountdown(clipMs);
}

function stopRecording() {
  isRecording = false;
  for (const segment of activeSegments) {
    clearTimeout(segment.nextTimer);
    clearTimeout(segment.stopTimer);
    if (segment.recorder.state === "recording") {
      segment.recorder.stop();
    }
  }

  if (!activeSegments.size) {
    cleanupRecordingStream();
  }

  stopSpeechRecognition();
  clearInterval(countdownTimer);
  document.body.classList.remove("is-recording");
  countdown.textContent = "--";
  recordingDot.classList.remove("active");
  recordingState.textContent = isUploading ? "Finishing upload" : "Idle";
  startButton.disabled = false;
  clipNowButton.disabled = true;
  stopButton.disabled = true;
  clipSecondsInput.disabled = false;
}

function clipNow() {
  if (!isRecording || !activeSegments.size) return;

  recordingState.textContent = "Clipping now";
  clipNowButton.disabled = true;
  const currentSegment = [...activeSegments].sort((a, b) => a.startedMs - b.startedMs)[0];

  for (const segment of activeSegments) {
    clearTimeout(segment.nextTimer);
    clearTimeout(segment.stopTimer);
    segment.discard = segment !== currentSegment;
    if (segment.recorder.state === "recording") {
      segment.recorder.stop();
    }
  }
}

function startSegment() {
  if (!isRecording || !stream) return;

  const clipMs = getClipMs();
  const overlapMs = getOverlapMs(clipMs);
  const segment = {
    chunks: [],
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    stopsAt: Date.now() + clipMs,
    discard: false,
  };

  segment.recorder = new MediaRecorder(stream, mediaRecorderOptions());
  activeSegments.add(segment);
  updateNextChunkAt();

  segment.recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      segment.chunks.push(event.data);
    }
  });
  segment.recorder.addEventListener("stop", () => handleSegmentStop(segment), { once: true });
  segment.recorder.start();

  segment.nextTimer = window.setTimeout(() => {
    if (isRecording && stream) {
      startSegment();
    }
  }, Math.max(250, clipMs - overlapMs));

  segment.stopTimer = window.setTimeout(() => {
    if (segment.recorder.state === "recording") {
      segment.recorder.stop();
    }
  }, clipMs);
}

async function handleSegmentStop(segment) {
  clearTimeout(segment.nextTimer);
  clearTimeout(segment.stopTimer);
  activeSegments.delete(segment);
  updateNextChunkAt();

  const chunks = segment.chunks;
  const startedAt = segment.startedAt;
  const endedAt = new Date().toISOString();
  const browserTranscript = pendingSpeechText.trim();
  if (!segment.discard) {
    pendingSpeechText = "";
  }

  if (!isRecording && !activeSegments.size) {
    cleanupRecordingStream();
  }

  if (segment.discard) {
    if (isRecording && !activeSegments.size) {
      startSegment();
      recordingState.textContent = isUploading ? "Uploading clip" : "Recording";
      clipNowButton.disabled = false;
    }
    return;
  }

  if (isRecording && !activeSegments.size) {
    startSegment();
    clipNowButton.disabled = false;
  }

  if (!chunks.length) return;

  const mimeType = segment.recorder.mimeType || "video/webm";
  const clipBlob = new Blob(chunks, { type: mimeType });
  clipNumber += 1;
  clipCount.textContent = `${clipNumber} clip${clipNumber === 1 ? "" : "s"}`;
  recordingState.textContent = "Uploading clip";
  isUploading = true;

  const form = new FormData();
  form.append("clip", clipBlob, `clip-${String(clipNumber).padStart(4, "0")}.webm`);
  form.append("clipNumber", String(clipNumber));
  form.append("startedAt", startedAt);
  form.append("endedAt", endedAt);
  form.append("browserTranscript", browserTranscript);

  try {
    const response = await fetch("/api/upload-clip", {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Upload failed");
    }
    await refreshClips();
  } catch (error) {
    answerEl.classList.remove("empty");
    answerEl.textContent = `Clip upload failed: ${error.message}`;
  } finally {
    isUploading = false;
    recordingState.textContent = isRecording ? "Recording" : "Idle";
    clipNowButton.disabled = !isRecording;
  }
}

function updateNextChunkAt() {
  const stopTimes = [...activeSegments].map((segment) => segment.stopsAt);
  nextChunkAt = stopTimes.length ? Math.min(...stopTimes) : undefined;
}

function cleanupRecordingStream() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  preview.srcObject = null;
}

async function refreshClips() {
  const response = await fetch("/api/clips?limit=30");
  const clips = await response.json();
  latestClips = clips;
  renderBrain(clips);
  clipsEl.innerHTML = "";

  if (!clips.length) {
    clipsEl.innerHTML = '<div class="clip"><p>No clips yet. Start recording to create Monocle memory.</p></div>';
    return;
  }

  for (const clip of clips) {
    const row = document.createElement("article");
    row.className = "clip";

    const topics = (clip.topics || [])
      .map((topic) => `<span class="tag">${escapeHtml(topic)}</span>`)
      .join("");

    const body = clip.summary || clip.visualSummary || clip.transcript || (clip.errors || []).join(" ");
    const visualDetails = [
      clip.visualSummary && `Visual: ${clip.visualSummary}`,
      clip.clothing?.length && `Clothing: ${clip.clothing.join(", ")}`,
      clip.visibleText && `Visible text: ${clip.visibleText}`,
    ]
      .filter(Boolean)
      .join("\n");
    const frame = clip.frameUrl
      ? `<img class="clip-frame" src="${clip.frameUrl}" alt="Representative frame for clip ${clip.clipNumber || ""}" />`
      : "";
    row.classList.toggle("has-frame", Boolean(clip.frameUrl));

    row.innerHTML = `
      ${frame}
      <div class="clip-body">
        <header>
          <strong>Clip ${clip.clipNumber || "?"}</strong>
          <span>${formatClock(clip.startedAt)}-${formatClock(clip.endedAt)}</span>
        </header>
        <p>${escapeHtml(body || "Saved, pending transcript.")}</p>
        ${topics ? `<div class="tags">${topics}</div>` : ""}
        ${visualDetails ? `<small>${escapeHtml(visualDetails)}</small>` : ""}
        <small>${escapeHtml((clip.transcript || "").slice(0, 420))}</small>
        <a href="${clip.url}" target="_blank" rel="noreferrer">Open video clip</a>
      </div>
    `;
    clipsEl.append(row);
  }
}

async function clearMemory() {
  const confirmed = window.confirm("Clear all Monocle clips, transcripts, and summaries?");
  if (!confirmed) return;

  clearMemoryButton.disabled = true;
  clearMemoryButton.textContent = "Clearing";

  try {
    const response = await fetch("/api/reset", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Clear failed");
    }

    answerEl.classList.add("empty");
    answerEl.textContent = "Answers will appear here.";
    conversationSnippets = [];
    localStorage.removeItem("monocleConversationSnippets");
    await refreshClips();
  } catch (error) {
    answerEl.classList.remove("empty");
    answerEl.textContent = `Clear failed: ${error.message}`;
  } finally {
    clearMemoryButton.disabled = false;
    clearMemoryButton.textContent = "Clear";
  }
}

function startBrainLoop() {
  clearInterval(brainRenderTimer);
  brainRenderTimer = window.setInterval(async () => {
    try {
      const response = await fetch("/api/clips?limit=40");
      const clips = await response.json();
      latestClips = clips;
      renderBrain(clips);
    } catch {
      renderBrain(latestClips);
    }
  }, 7000);
}

function renderBrain(clips) {
  if (!wordCloudEl || !brainMeterEl) return;

  const words = extractBrainWords(clips);
  const displayWords = words.length ? words : fallbackBrainWords();
  const isCompact = wordCloudEl.clientWidth < 620;
  const selected = displayWords.slice(0, isCompact ? 38 : 58);

  const wordSignature = selected.map((entry) => `${entry.word}:${Math.round(entry.weight * 10)}`).join("|");
  if (wordSignature !== lastBrainWordSignature) {
    lastBrainWordSignature = wordSignature;
    wordCloudEl.innerHTML = selected
      .map((entry, index) => {
        const seed = hashWord(`${entry.word}-${index}`);
        const { x, y } = brainWordPosition(index, seed, selected.length, isCompact);
        const cappedWeight = Math.min(entry.weight, 6);
        const rankBoost = Math.max(0, 12 - index) * (isCompact ? 0.28 : 0.45);
        const size = Math.min(
          isCompact ? 22 : 34,
          (isCompact ? 12 : 15) + cappedWeight * (isCompact ? 1.05 : 2.45) + rankBoost,
        );
        const alpha = Math.min(0.96, 0.62 + cappedWeight * 0.045 + (index < 10 ? 0.12 : 0));
        const delay = -((seed % 5000) / 1000).toFixed(2);
        const drift = 10 + (seed % 10);
        return `<span class="brain-word" style="--x:${x}%; --y:${y}%; --size:${size}px; --alpha:${alpha}; --order:${seed % 1000}; --delay:${delay}s; --drift:${drift}s">${escapeHtml(entry.word)}</span>`;
      })
      .join("");
  }

  const visualCount = clips.filter((clip) => clip.visualSummary).length;
  brainMeterEl.textContent = clips.length
    ? `${clips.length} clips / ${visualCount} visual memories`
    : "Waiting for memory";
}

function brainWordPosition(index, seed, total, isCompact) {
  const zone = index % 4;
  const rank = Math.floor(index / 4);
  const perZone = Math.ceil(total / 4);
  const progress = perZone <= 1 ? 0.5 : (rank + 0.5) / perZone;
  const jitterX = (((seed % 100) / 100) - 0.5) * (isCompact ? 5 : 7);
  const jitterY = ((((seed >> 8) % 100) / 100) - 0.5) * (isCompact ? 4 : 6);
  const columns = isCompact ? 3 : 5;
  const column = rank % columns;
  const row = Math.floor(rank / columns);
  const columnProgress = columns <= 1 ? 0.5 : (column + 0.5) / columns;

  if (zone === 0) {
    return { x: 13 + columnProgress * 74 + jitterX, y: 11 + row * (isCompact ? 13 : 11) + jitterY };
  }

  if (zone === 1) {
    return { x: 87 - columnProgress * 74 + jitterX, y: 88 - row * (isCompact ? 13 : 11) + jitterY };
  }

  if (zone === 2) {
    return { x: 15 + (rank % 2) * 7 + jitterX, y: 25 + progress * 50 + jitterY };
  }

  return { x: 85 - (rank % 2) * 7 + jitterX, y: 75 - progress * 50 + jitterY };
}

function extractBrainWords(clips) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "andy",
    "around",
    "because",
    "being",
    "background",
    "beard",
    "blue",
    "blurred",
    "brown",
    "ceiling",
    "clips",
    "close-up",
    "close",
    "could",
    "curtain",
    "curtains",
    "dark",
    "from",
    "foreground",
    "glasses",
    "going",
    "green",
    "hair",
    "have",
    "here",
    "indoor",
    "indoors",
    "individual",
    "into",
    "just",
    "light",
    "lighting",
    "like",
    "male",
    "memory",
    "metal",
    "monocle",
    "more",
    "name",
    "object",
    "objects",
    "office",
    "person",
    "people",
    "really",
    "shelf",
    "shelves",
    "shirt",
    "short",
    "sitting",
    "some",
    "sweatshirt",
    "that",
    "their",
    "there",
    "this",
    "today",
    "video",
    "visible",
    "with",
    "would",
    "wearing",
    "webcam",
    "wooden",
    "what",
    "yeah",
    "your",
  ]);

  const counts = new Map();
  const pushWord = (word, boost = 1) => {
    const normalized = word.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (normalized.length < 4 || stopWords.has(normalized)) return;
    counts.set(normalized, (counts.get(normalized) || 0) + boost);
  };

  const pushField = (field, boost = 1) => {
    for (const word of String(field).match(/\b[a-zA-Z][a-zA-Z0-9-]{3,}\b/g) || []) {
      pushWord(word, boost);
    }
  };

  for (const clip of clips) {
    pushField(clip.transcript, 3);
    pushField(clip.summary, clip.transcript ? 1 : 0.35);
    pushField(clip.visualSummary, 0.2);
    pushField(clip.visibleText, 2);
    (clip.topics || []).forEach((field) => pushField(field, 3));
    (clip.actionItems || []).forEach((field) => pushField(field, 3));
  }

  conversationSnippets.forEach((snippet) => pushField(snippet, 2));

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, weight]) => ({ word, weight }));
}

function rememberConversation(question, answer) {
  conversationSnippets = [`${question} ${answer}`, ...conversationSnippets].slice(0, 12);
  localStorage.setItem("monocleConversationSnippets", JSON.stringify(conversationSnippets));
}

function loadConversationSnippets() {
  try {
    const stored = JSON.parse(localStorage.getItem("monocleConversationSnippets") || "[]");
    return Array.isArray(stored) ? stored.filter(Boolean).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function fallbackBrainWords() {
  return [
    "listening",
    "vision",
    "speech",
    "context",
    "recall",
    "timeline",
    "ambient",
    "attention",
    "thought",
    "capture",
    "signals",
    "summary",
    "presenting",
    "question",
  ].map((word, index) => ({ word, weight: 5 - (index % 4) }));
}

function hashWord(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function startBrainCanvas() {
  if (!brainCanvas) return;

  const context = brainCanvas.getContext("2d");
  const resize = () => {
    const box = brainCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    brainCanvas.width = Math.max(1, Math.floor(box.width * dpr));
    brainCanvas.height = Math.max(1, Math.floor(box.height * dpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    neuralNodes = buildNeuralNodes(box.width, box.height);
  };

  resize();
  window.addEventListener("resize", resize);

  const draw = (time) => {
    const box = brainCanvas.getBoundingClientRect();
    drawBrainFrame(context, box.width, box.height, time / 1000);
    brainAnimationFrame = window.requestAnimationFrame(draw);
  };

  window.cancelAnimationFrame(brainAnimationFrame);
  brainAnimationFrame = window.requestAnimationFrame(draw);
}

function buildNeuralNodes(width, height) {
  const centerX = width * 0.5;
  const centerY = height * 0.47;
  const radius = Math.min(width * 0.26, height * 0.32);

  return Array.from({ length: 42 }, (_, index) => {
    const seed = hashWord(`node-${index}-${Math.round(width)}-${Math.round(height)}`);
    const angle = (seed % 628) / 100;
    const distance = radius * (0.18 + ((seed >> 5) % 74) / 100);
    return {
      x: centerX + Math.cos(angle) * distance * 1.02,
      y: centerY + Math.sin(angle) * distance * 0.86,
      phase: (seed % 1000) / 160,
      link: index > 0 ? Math.max(0, index - 1 - (seed % Math.min(index, 5))) : 0,
    };
  });
}

function drawBrainFrame(context, width, height, seconds) {
  context.clearRect(0, 0, width, height);

  const centerX = width * 0.5;
  const centerY = height * 0.48;
  const scale = Math.min(width * 0.58, height * 0.9);

  context.save();
  context.globalAlpha = 0.95;
  drawBrainGlow(context, centerX, centerY, scale, seconds);
  drawBrainBody(context, centerX, centerY, scale, seconds);
  drawNeuralMesh(context, seconds);
  drawBrainEyes(context, centerX, centerY, scale, seconds);
  context.restore();
}

function drawBrainGlow(context, centerX, centerY, scale, seconds) {
  const pulse = 0.5 + Math.sin(seconds * 1.8) * 0.5;
  const glow = context.createRadialGradient(centerX, centerY, scale * 0.06, centerX, centerY, scale * 0.52);
  glow.addColorStop(0, `rgba(16, 185, 129, ${0.16 + pulse * 0.08})`);
  glow.addColorStop(0.46, "rgba(111, 231, 202, 0.08)");
  glow.addColorStop(1, "rgba(16, 185, 129, 0)");
  context.fillStyle = glow;
  context.beginPath();
  context.ellipse(centerX, centerY, scale * 0.46, scale * 0.38, 0, 0, Math.PI * 2);
  context.fill();
}

function drawBrainBody(context, centerX, centerY, scale, seconds) {
  context.save();
  context.translate(centerX, centerY + Math.sin(seconds * 1.2) * 4);

  const body = new Path2D();
  const w = scale * 0.48;
  const h = scale * 0.43;
  body.moveTo(-w * 0.47, -h * 0.08);
  body.bezierCurveTo(-w * 0.56, -h * 0.48, -w * 0.16, -h * 0.61, -w * 0.02, -h * 0.46);
  body.bezierCurveTo(w * 0.12, -h * 0.67, w * 0.52, -h * 0.45, w * 0.49, -h * 0.1);
  body.bezierCurveTo(w * 0.66, h * 0.16, w * 0.37, h * 0.47, w * 0.09, h * 0.42);
  body.bezierCurveTo(-w * 0.06, h * 0.6, -w * 0.5, h * 0.44, -w * 0.45, h * 0.12);
  body.bezierCurveTo(-w * 0.59, h * 0.06, -w * 0.6, -h * 0.03, -w * 0.47, -h * 0.08);
  body.closePath();

  const fill = context.createLinearGradient(-w * 0.5, -h * 0.5, w * 0.48, h * 0.46);
  fill.addColorStop(0, "rgba(244, 244, 246, 0.14)");
  fill.addColorStop(0.42, "rgba(35, 38, 40, 0.98)");
  fill.addColorStop(1, "rgba(16, 18, 20, 0.98)");

  context.fillStyle = fill;
  context.strokeStyle = "rgba(241, 242, 244, 0.78)";
  context.lineWidth = 2;
  context.shadowColor = "rgba(16, 185, 129, 0.22)";
  context.shadowBlur = 24;
  context.fill(body);
  context.stroke(body);

  context.clip(body);
  context.shadowBlur = 0;
  context.strokeStyle = "rgba(244, 244, 246, 0.16)";
  context.lineWidth = 1.3;
  for (let index = 0; index < 9; index += 1) {
    const y = -h * 0.32 + index * h * 0.085 + Math.sin(seconds * 1.5 + index) * 3;
    context.beginPath();
    context.bezierCurveTo(
      -w * 0.35,
      y,
      -w * 0.08,
      y - h * 0.11,
      w * 0.08,
      y + h * 0.04,
    );
    context.bezierCurveTo(w * 0.18, y + h * 0.12, w * 0.33, y - h * 0.03, w * 0.42, y + h * 0.08);
    context.stroke();
  }
  context.restore();
}

function drawNeuralMesh(context, seconds) {
  if (!neuralNodes.length) return;

  context.save();
  neuralNodes.forEach((node, index) => {
    const linkedNode = neuralNodes[node.link];
    if (linkedNode && index % 2 === 0) {
      const signal = 0.35 + Math.sin(seconds * 2.2 + node.phase) * 0.32;
      context.strokeStyle = `rgba(16, 185, 129, ${signal})`;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(node.x, node.y);
      context.lineTo(linkedNode.x, linkedNode.y);
      context.stroke();
    }

    const radius = 1.4 + Math.sin(seconds * 2.7 + node.phase) * 0.7;
    context.fillStyle = index % 3 === 0 ? "rgba(244, 244, 246, 0.82)" : "rgba(16, 185, 129, 0.72)";
    context.beginPath();
    context.arc(node.x, node.y, Math.max(0.7, radius), 0, Math.PI * 2);
    context.fill();
  });
  context.restore();
}

function drawBrainEyes(context, centerX, centerY, scale, seconds) {
  const eyeY = centerY + scale * 0.02;
  const eyeGap = scale * 0.12;
  const pupilShift = Math.sin(seconds * 1.7) * scale * 0.016;

  context.save();
  [centerX - eyeGap, centerX + eyeGap].forEach((x) => {
    context.fillStyle = "rgba(244, 244, 246, 0.94)";
    context.strokeStyle = "rgba(255, 255, 255, 0.8)";
    context.lineWidth = 1.2;
    context.beginPath();
    context.ellipse(x, eyeY, scale * 0.048, scale * 0.027, 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    context.fillStyle = "#08090a";
    context.beginPath();
    context.arc(x + pupilShift, eyeY, scale * 0.012, 0, Math.PI * 2);
    context.fill();
  });

  context.strokeStyle = "rgba(244, 244, 246, 0.66)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(centerX - scale * 0.095, centerY + scale * 0.12);
  context.lineTo(centerX + scale * 0.095, centerY + scale * 0.12);
  context.stroke();
  context.restore();
}

function mediaRecorderOptions() {
  const preferred = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];

  const mimeType = preferred.find((type) => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : undefined;
}

function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    apiStatus.textContent += " Browser speech fallback is unavailable in this browser.";
    return;
  }

  shouldRunSpeechRecognition = true;
  pendingSpeechText = "";
  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = false;
  speechRecognition.lang = navigator.language || "en-US";

  speechRecognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) {
        pendingSpeechText += ` ${result[0].transcript.trim()}`;
      }
    }
  };

  speechRecognition.onend = () => {
    if (shouldRunSpeechRecognition) {
      window.setTimeout(() => speechRecognition?.start(), 300);
    }
  };

  speechRecognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      shouldRunSpeechRecognition = false;
    }
  };

  try {
    speechRecognition.start();
  } catch {
    shouldRunSpeechRecognition = false;
  }
}

function stopSpeechRecognition() {
  shouldRunSpeechRecognition = false;
  if (speechRecognition) {
    try {
      speechRecognition.stop();
    } catch {
      // The recognizer may already be stopped by the browser.
    }
  }
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!nextChunkAt) {
      countdown.textContent = "--";
      return;
    }

    const remaining = Math.max(0, nextChunkAt - Date.now());
    countdown.textContent = `${Math.ceil(remaining / 1000)}s to next clip`;
  }, 250);
}

function getClipMs() {
  return Math.max(5, Math.min(120, Number(clipSecondsInput.value || 30))) * 1000;
}

function getOverlapMs(clipMs) {
  return Math.min(2000, Math.max(750, Math.floor(clipMs * 0.2)));
}

function formatClock(value) {
  if (!value) return "--:--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
