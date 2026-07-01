# Monocle

Hackathon POC for continuous webcam/microphone room memory. The app records short overlapping clips, extracts audio and visual summaries, and lets Codex query recent room context through the local Monocle bridge.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Then open `http://localhost:5177`.

## Notes

- Requires `ffmpeg` on the local machine for audio and frame extraction.
- `.env`, generated clips, extracted audio, frames, metadata, and memory logs are intentionally ignored.
- Codex bridge:

```bash
npm run ask:monocle -- "/monocle what was the latest presentation about"
```
