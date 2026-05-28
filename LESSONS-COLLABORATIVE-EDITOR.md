# Lessons Building a Real-Time Collaborative Editor

I started with a deceptively small goal: an Electron + Monaco desktop editor that two people could type in at the same time. The repo today is the prototype — main process, preload, renderer, Monaco bundled through webpack, save dialog wired up. About 150 lines of glue. The README calls it "Live-Sync Collaborative" because that's where it's going. This post is the gap between those 150 lines and a system that two thousand engineers in different time zones could share a buffer in without losing characters.

I'm going to write it the way I'd actually build it in production, not the way textbooks describe CRDTs. Tools I'd reach for: **Postgres, Redis, Kafka, Nginx, Docker, Y.js**. Failures I'd plan for: network partitions, snapshot drift, runaway op logs, the one user on hotel Wi-Fi.

---

## The naive version (and why it dies in week two)

The first instinct, looking at the current code, is obvious:

```
Electron A ──► WebSocket ──► Node server ──► WebSocket ──► Electron B
```

Every keystroke is a `{ insert: "x", at: 47 }` message. Server rebroadcasts. Done by Friday.

This dies the moment two people type at the same position. A inserts `"foo"` at offset 10. B inserts `"bar"` at offset 10. The server sees both. Whose ends up at offset 10? Whichever arrived first — and now A and B disagree on what offset 11 means. From that point on, every subsequent operation is computed against a different document. Within seconds the two clients have silently diverged.

The fix isn't "lock the document" — that's not collaborative, that's Google Docs circa 2005. The fix is to stop pretending that an offset means the same thing on two machines.

---

## CRDT vs OT — the decision that shapes everything else

Two real options:

**Operational Transformation (OT)** — the Google Docs lineage. Operations are transformed against concurrent operations server-side. Requires a central authority. Hard to get right (Google's paper had bugs that took years to find). Cheap on the wire.

**CRDTs** — Conflict-free Replicated Data Types. Every character gets a unique, ordered ID (not an integer offset). Insertions are commutative: applying A then B gives the same document as B then A. No central transform required. Heavier on memory and metadata.

I'd pick CRDTs, specifically **Y.js**, and I'd pick it for one reason: the rest of this system gets *dramatically* simpler when the server doesn't have to be smart. The server becomes a relay and a persistence layer. It can crash, restart, shard, replicate — the clients still converge.

OT is the right answer if your wire-format budget is tiny (mobile, satellite). For a desktop Electron app over broadband, the metadata overhead is invisible.

There is real prior art here. Figma uses a custom CRDT-ish multiplayer system. Linear uses Y.js. Notion uses a block-CRDT model. The pattern is well-trodden enough that "build the protocol yourself" is no longer a defensible choice.

---

## The architecture I'd actually deploy

```
                      ┌─────────────────────────────────────┐
                      │            Nginx (TLS, sticky)      │
                      └──────────────┬──────────────────────┘
                                     │
                      ┌──────────────┴──────────────┐
                      ▼                             ▼
              ┌──────────────┐              ┌──────────────┐
              │ Sync gateway │   ...        │ Sync gateway │   (Node, stateless)
              │  (WebSocket) │              │  (WebSocket) │
              └──────┬───────┘              └──────┬───────┘
                     │                             │
                     └──────────────┬──────────────┘
                                    ▼
                    ┌──────────────────────────────┐
                    │  Redis  (pub/sub + presence) │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  Kafka  (durable op log)     │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │  Postgres  (snapshots + ACL) │
                    └──────────────────────────────┘

   Object store (S3/MinIO) ◄── periodic snapshots for cold docs
```

A few pieces worth unpacking.

### Sync gateway — stateless on purpose

Each gateway holds open WebSocket connections and forwards Y.js update messages. **It holds no canonical document state.** The document lives in Redis (hot) and Postgres/S3 (cold). If a gateway dies, the client reconnects (Nginx routes via sticky session on `doc_id`), re-hydrates from the last known state vector, and resumes.

Stateless gateways mean horizontal scaling is `docker compose scale gateway=N`. No node is special. No leader election.

### Redis — pub/sub and presence, not source of truth

Redis does two things:

1. **Pub/sub channel per document.** Gateway A receives an update for `doc:abc`, publishes it on `doc:abc`. Every other gateway subscribed to `doc:abc` (because it has clients on that doc) fans out to its WebSockets. This is how a user on gateway-3 sees a keystroke from a user on gateway-7.
2. **Presence.** `HSET presence:doc:abc user:42 '{"cursor": 102, "color": "#f0a"}'` with a TTL of ~30s, refreshed by heartbeat. Cursors and "X is typing" are ephemeral — losing them on a Redis restart is fine.

Redis is *not* where the document lives. If Redis dies, no edits are lost; only in-flight relay is briefly interrupted.

### Kafka — the op log that lets you replay history

Every Y.js update gets appended to a Kafka topic keyed by `doc_id`. This is the durable record. Three things become easy once you have it:

- **Snapshotting.** A consumer reads the topic, materializes the document state, writes a snapshot to Postgres (or S3 for large docs) every N updates or T seconds.
- **Audit / undo across sessions.** "Who deleted line 412 last Tuesday?" is a Kafka seek.
- **Backfill new replicas.** Spin up a new region; replay the topic; you have the document.

You could replace Kafka with Postgres logical replication or even a `JSONB` append table for small scale. Kafka earns its keep around 10k+ concurrent docs or when you want the op log to be the integration point for other services (search indexing, ML on edit patterns, etc.).

### Postgres — snapshots, ACL, and metadata

Postgres holds:

- The latest snapshot per document (binary Y.js state, ~1–50 KB typical).
- ACL: which users can read/write which docs.
- Document metadata: title, owner, created_at, version vector.

Snapshots + the tail of the Kafka log = current state. Cold documents (no edits in 24h) get their snapshot pushed to S3/MinIO and evicted from Postgres to keep the hot table small.

---

## Where it breaks (the part most blog posts skip)

### 1. The reconnect storm

A network blip drops 5,000 WebSocket connections. They all reconnect within 2 seconds. Each sends its state vector, the gateway computes a diff against the current doc, ships back potentially megabytes of updates. The gateways CPU-spike, Redis pub/sub backs up, latency for *other* docs degrades.

Mitigations:
- **Jittered reconnect backoff** on the client (250ms–5s random).
- **Diff capping** — if a client's state vector is more than N updates behind, ship the latest snapshot instead of replaying.
- **Per-IP connection rate limits at Nginx.**

### 2. The runaway op log

One user holds down a key. Or worse: a buggy script types 10k chars/sec. Y.js will happily encode all of it. Kafka will happily store all of it. Your snapshot table grows.

Mitigations:
- **Server-side rate limit per session** (e.g., 200 ops/sec). Reject excess; the client buffers and merges locally — Y.js does this naturally.
- **Compaction.** Periodic background job reads Kafka, produces a compacted snapshot, advances the retention pointer. Y.js's `encodeStateAsUpdate` is exactly this.

### 3. Snapshot drift

You restored a doc from a snapshot taken at op #4,500. Kafka's retention deleted ops #0–#4,000. A client reconnects with a state vector pointing at op #3,800. You cannot satisfy this client without the old ops.

Mitigations:
- **Retention policy bounded by snapshot frequency.** Never delete from Kafka unless a newer snapshot covers that range.
- **Client-side checkpoint discipline.** Y.js clients should persist their own state on disk (Electron makes this trivial with `app.getPath('userData')`) so they can resume from local state instead of asking the server for history.

### 4. The offline-laptop problem (Electron-specific)

This is the killer feature and the hardest case. Someone closes the lid on a train, opens it three hours later, types for ten minutes offline, then reconnects. Meanwhile six other people edited the same doc.

CRDTs *make this possible* but they don't make it safe. The merge is mathematically clean — the result is one document, no errors thrown — but semantically chaotic if both branches edited the same function.

The honest production answer is:
- Merge automatically (this is Y.js's whole point).
- **Surface the divergence in the UI.** A diff strip showing "your offline edits vs. what changed while you were away." Let humans resolve semantic conflicts; let the CRDT resolve syntactic ones.
- **Use IndexedDB or SQLite (via Electron) as the local store.** `y-indexeddb` is a drop-in.

The current prototype already has the right boundary for this — `preload.js` exposes `readFile`/`readDir`, and we'd add a `getLocalDocStore` of the same shape.

### 5. Split brain during a region failover

You run two regions. The link between them flaps for 90 seconds. Clients in each region keep editing. When the link heals, both sides have diverged Kafka topics.

CRDT to the rescue, *almost*. The document state will converge. But your Kafka log won't — you now have two histories of the same doc that need to be interleaved. This is solvable (write a merger that consumes both topics and produces a unified one) but it's the kind of thing you want to discover by running a chaos test, not in production at 3 AM.

---

## What stays the same vs. the current prototype

The current code has the right bones for this evolution, which is mildly surprising for ~150 lines:

| Today's code                                       | Stays / changes                              |
|----------------------------------------------------|----------------------------------------------|
| `main.js` opens BrowserWindow, owns fs             | Stays. Add a "Connect to room…" menu item.   |
| `preload.js` exposes `window.api` via contextBridge| Stays. Add `connectRoom`, `applyUpdate`, `onRemoteUpdate`. |
| `renderer.js` wires Monaco to file IO              | Add Y.js binding: `new MonacoBinding(ytext, monaco.getModel(), …)`. |
| `src/editor.js` creates Monaco                     | Unchanged.                                   |
| Webpack bundles renderer                           | Unchanged; add `yjs` and `y-monaco`.         |
| Save = "Save As" every time                        | Becomes "Save snapshot to server" + local autosave via `y-indexeddb`. |

The Electron security posture (`contextIsolation: true`, `nodeIntegration: false`) is already correct and will matter much more once the renderer talks to an untrusted server.

---

## Tradeoffs I'd make on day one

| Decision                            | Choice                | Why                                                           |
|-------------------------------------|-----------------------|---------------------------------------------------------------|
| CRDT vs OT                          | CRDT (Y.js)           | Stateless server, offline-first, well-trodden                 |
| Transport                           | WebSocket over TLS    | Nginx terminates; HTTP/2 push isn't worth the complexity      |
| Peer-to-peer (WebRTC)               | **No**                | NAT traversal, no central audit log, no enterprise story      |
| Document storage                    | Postgres snapshot + Kafka log | Cheap to start, scales to millions of docs           |
| Auth                                | Signed JWT in `Sec-WebSocket-Protocol` header | One round-trip, gateway can validate stateless |
| Snapshot cadence                    | Every 500 ops or 60s, whichever first | Bounds replay cost on reconnect              |
| Presence backend                    | Redis with TTL        | Lose it freely on restart                                     |
| Deployment unit                     | Docker; one image per role (gateway, snapshotter, api) | Easy to scale roles independently |

Two non-obvious choices to call out:

**No WebRTC for the data channel.** WebRTC sounds great for a "collaborative editor" — direct peer connections, low latency, sci-fi. In practice you pay for it with TURN servers (because half your users are behind symmetric NATs), with the loss of a central op log (no audit, no async backfill, no server-side search), and with a much harder auth story. Use WebRTC for voice/video chat over the same doc; don't use it for the document itself.

**JWT in the WebSocket subprotocol header**, not in a query string. Query strings end up in Nginx logs. Subprotocol headers don't. Small detail; sleeps better at night.

---

## Where I'd start tomorrow

If I had one week to move this prototype meaningfully toward the production picture above, in order:

1. **Add `yjs`, `y-monaco`, `y-websocket`, `y-indexeddb` to the renderer bundle.** Wire `MonacoBinding`. The editor is now CRDT-backed locally even with no server.
2. **Stand up the smallest possible `y-websocket` server in a Docker container.** Two clients, one doc, real-time sync working end-to-end. No persistence yet.
3. **Add Postgres + a periodic snapshot job.** Replace `y-websocket`'s in-memory store with one that loads/saves snapshots on connect/disconnect.
4. **Add auth.** Even a hardcoded shared secret is enough to stop drive-by edits while the rest of the stack matures.
5. **Add Redis pub/sub** so the next gateway pod actually sees the same doc.

Kafka, multi-region, presence cursors, conflict-surfacing UI — none of that is week one. Week one is: prove the CRDT loop closes across two laptops.

---

## The lesson

The interesting work in a collaborative editor isn't the editor. Monaco is already a complete editor; it took ten lines in `src/editor.js`. The interesting work is the boundary between a single user's mental model of a file and a distributed system's eventual consistency guarantees — and most of that work happens in deciding *which guarantees you don't need*.

You don't need strict ordering. You don't need a single source of truth at any instant. You don't need locks. You need convergence, presence, and the ability to tell a human "you and Alice both edited line 87; here's the merge — does it look right?"

Get those three things, and the rest is plumbing. Pick boring tools for the plumbing.
