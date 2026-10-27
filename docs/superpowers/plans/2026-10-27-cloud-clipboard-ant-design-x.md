# Cloud Clipboard UX and Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable clipboard authentication, allow up to 10 GiB per file and unrestricted practical text, and replace the Vue frontend with an Ant Design X React chat interface.

**Architecture:** Keep the existing Node/Koa/WebSocket backend and its API contract. Build a React SPA using Ant Design X components in the existing client build stage; reuse REST and WebSocket endpoints and retain room, history, uploads, file access, and live sync. Set upload limits explicitly in Koa/formidable, accept large text bodies as a stream, and raise the Caddy request-body limit to 10 GiB while documenting that Cloudflare plan/edge limits may still prevent 10 GiB public uploads.

**Tech Stack:** Node.js 22, Koa, React, Ant Design, Ant Design X, Vite, Docker Compose, Caddy.

---

### Task 1: Set public-service limits and disable auth

**Files:**
- Modify: `/root/cloud-clipboard/runtime/config.json`
- Modify: `/root/cloud-clipboard/server-node/app/http-router.js`
- Modify: `/root/cloud-clipboard/server-node/app/config.js`

- [ ] Set `server.auth` false, `text.limit` 0, and `file.limit` 10737418240 in runtime configuration.
- [ ] Change text middleware to stream arbitrary-length request data with a bounded chunk accumulator and no fixed parser textLimit; preserve text escaping and response format.
- [ ] Ensure all auth middleware and WebSocket checks permit unauthenticated service when auth is false.
- [ ] Add an integration test that submits text larger than 1 MiB and verifies success, and tests missing auth on HTTP and WebSocket routes.
- [ ] Run tests and verify intended pre-change failure then post-change success.

### Task 2: React + Ant Design X frontend foundation

**Files:**
- Modify: `/root/cloud-clipboard/client/package.json`
- Modify: `/root/cloud-clipboard/client/Dockerfile` or root `/root/cloud-clipboard/Dockerfile`
- Create: `/root/cloud-clipboard/client/index.html`
- Create: `/root/cloud-clipboard/client/src/main.jsx`
- Create: `/root/cloud-clipboard/client/src/App.jsx`
- Create: `/root/cloud-clipboard/client/src/styles.css`
- Modify: `/root/cloud-clipboard/Dockerfile`

- [ ] Add React, ReactDOM, Ant Design, Ant Design X and Vite with pinned compatible versions; configure build output to `server-node/static`.
- [ ] Write a failing component/API test for chat view, connection indicator, room support, and long text/file controls.
- [ ] Implement an Ant Design X-style responsive workspace: compact header, conversation timeline, empty-state prompts, fixed composer, text/file mode, connection state, room selector, theme toggle, clear history control.
- [ ] Preserve existing API routes: `server`, `push`, `text`, `upload/chunk`, `upload/finish`, `revoke`, `file`, `content`.
- [ ] Support image paste, file paste, drag/drop and chunked upload with progress; chunk size remains configured 2 MiB and each file may reach 10 GiB.
- [ ] Render text as escaped plain text; render file cards with name, size, expiration and download link.
- [ ] Run frontend tests and production build.

### Task 3: Proxy/body handling and deploy

**Files:**
- Modify: `/root/cloud-clipboard/compose.yaml`
- Modify: `/root/docker-configs/caddy/Caddyfile.live`

- [ ] Set Caddy `request_body` maximum to 10 GiB for `copy.uamme.com`.
- [ ] Recreate the app image/container after successful tests, keep data in `/root/cloud-clipboard/runtime/data`, and keep the app on the Caddy-shared Docker network.
- [ ] Validate Caddy config and reload.
- [ ] Verify public page loads React app, `/server` reports auth false, HTTP text longer than 1 MiB is accepted, and WebSocket upgrade succeeds without auth.
- [ ] Report Cloudflare upload cap caveat separately; do not claim 10 GiB internet uploads work through Cloudflare unless a real end-to-end test proves it.

### Task 4: Final regression checks

- [ ] Verify app container healthy and Caddy route resolves to `cloud-clipboard:9501`.
- [ ] Verify no authorization code is generated at startup.
- [ ] Verify `/root/cloud-clipboard/runtime/config.json` persists the intended limits and existing user data was preserved.
- [ ] Run final tests/build and provide concise deployment summary.
