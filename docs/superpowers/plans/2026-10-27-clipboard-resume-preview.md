# Clipboard Resume and Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large clipboard uploads resumable and add safe image/video/archive/document previews.

**Architecture:** Persist upload session metadata beside uploaded files and support offset-aware chunk writes, with client-side session recovery. Serve media using HTTP byte ranges; use a dedicated LibreOffice/Python worker sharing the upload directory for archive listings and Office-to-PDF conversion. Keep conversion isolated from the Node API and use controlled worker routes.

**Tech Stack:** Node.js/Koa, React/Ant Design X, Python FastAPI, LibreOffice, Docker Compose, Caddy.

---

### Task 1: Resumable upload protocol
- [ ] Persist incomplete sessions (UUID, original filename, byte count, timestamps), restore on process restart, and expire abandoned partial uploads.
- [ ] Add status and offset write routes; reject gaps/overlaps, constrain each chunk and full file limit; use positional file writes to support safe retries.
- [ ] Persist upload identity/offset in browser storage and offer resume on matching files; update progress and remove session after successful finish.
- [ ] Test offset replay, interruption and restart recovery, maximum file enforcement, and regular completion.

### Task 2: Media, archive, document preview worker
- [ ] Correctly implement GET/HEAD byte ranges (including suffix ranges and 416) for video/audio; add CORS, cache and MIME handling.
- [ ] Add a dedicated worker container with bounded CPU/memory/time, safe archive listing without extraction, and LibreOffice conversion to cached PDF.
- [ ] Restrict worker to opaque UUIDs under shared upload storage; validate archives against traversal entries and resource bombs; never execute archive contents.
- [ ] Add API preview routes and browser preview modal for image/video/audio, archive listing and converted PDF.
- [ ] Add regression tests for Range 206/416, ZIP path traversal rejection, unsupported documents, conversion errors, and filename safety.

### Task 3: Deploy and verify
- [ ] Run tests and build complete images before replacing live services.
- [ ] Preserve current upload/history data and existing API/UI features; confirm worker and app share only required data path.
- [ ] Verify resume through API, media range response, archive preview and Office-to-PDF preview with representative files.
- [ ] Read back deployed health, route, and worker readiness; document Cloudflare large-upload caps and preview limitations.
