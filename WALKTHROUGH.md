# Walkthrough — what this system is, how it works, and how to demo it

A companion to [`README.md`](./README.md). The README is the pitch; this is the guided tour:
what the project is for, why it's built this way, how a request actually flows through it,
what every file in `src/` does, and a script for walking someone through it live.

---

## 1. What this project is

An **infrastructure control plane** — the kind of internal service a cloud provider runs to
manage its own hardware. It owns a four-level inventory:

```
Cluster  (a datacenter region, e.g. "us-east-1a")
└── Rack  (a physical rack, e.g. "R01")
    └── Node  (a server: CPU, memory, a lifecycle status)
        └── GPU  (an accelerator card, attachable and detachable)
```

Operators use it to register hardware, provision nodes, move them through their lifecycle
(active → maintenance → retired), and answer "what happened to this machine, and who did it?"

**No real hardware is touched.** Provisioning is a `setTimeout`. That's deliberate: the
interesting part of this kind of system was never the hardware driver, it's everything
around it — concurrency control, asynchronous work, auditability, and transactional
integrity. Simulating the slow call keeps all of that intact while removing the parts that
can't be run on a laptop.

### The four problems it solves

This is the core of the project. Each is a real production failure mode with a specific fix.

| # | Problem | What goes wrong without it | The fix here |
|---|---|---|---|
| 1 | **Concurrent updates** | Two operators open a node, both see "active", both submit a change. The second silently overwrites the first. Nobody ever finds out. | **Optimistic locking** — every node has a `version`; a write must declare the version it read, and the version is a predicate on the `UPDATE` itself. Lost the race → `409`. |
| 2 | **Slow operations** | Provisioning takes 10 minutes. The HTTP request holds a connection open, the client times out, and nobody knows whether the work happened. | **Async jobs** — `POST /nodes` records intent, returns `202` with a job to poll, and a worker does the work off a queue. |
| 3 | **Lost history** | A node is "failed". Why? When? Who changed it? The status column only holds the present tense. | **Append-only audit trail** — every transition writes a `lifecycle_events` row, in the same transaction as the change. Never updated, never deleted. |
| 4 | **Partial writes** | Provisioning creates a node, then the GPU insert fails. Now there's a server with no hardware, and inventory is wrong forever. | **Transactions** — node + GPUs + audit events commit together or not at all. |

Plus the supporting cast that any real service needs: JWT auth, role-based access control,
schema validation at the edge, rate limiting, health probes, structured logs with
correlation ids, and graceful shutdown.

### Why these choices

- **Optimistic** locking, not pessimistic. Row locks (`SELECT ... FOR UPDATE`) serialise
  writers and hold a transaction open across a user's think-time. Conflicts on a node are
  rare, so it's cheaper to detect them and ask the loser to retry than to make every writer
  queue.
- **A state machine in one file**, not `if (status === ...)` scattered through routes. Both
  the API and the worker call the same `assertTransition`, so there's no path that skips the
  rules. Adding a state is a one-line change.
- **The queue carries commands *and* events**, on two exchanges. Commands say "do this" and
  go to one worker. Events say "this happened" and the publisher doesn't name a consumer —
  so adding billing or notifications later means binding a new queue and changing no
  existing code.
- **Events are published after commit**, never inside the transaction. Publishing inside
  means a consumer can see an event for work that then rolls back, and no amount of
  downstream retrying fixes that.
- **The slow work sits outside the transaction.** Holding a Postgres transaction open for a
  ten-minute operation pins a connection and blocks vacuum. Instead the node sits in
  `PROVISIONING` — visible to readers — until it resolves.
- **Soft deletes.** Hardware inventory is an audit surface; a deleted node's history and
  GPU serial numbers still matter. `deletedAt` hides the row from reads and keeps the record.
- **Keyset pagination**, not `OFFSET`. Page 500 costs the same as page 1, and rows inserted
  mid-scan can't cause duplicates or skipped records.

---

## 2. How to run it

**Prerequisites:** Docker Desktop running, plus Node 22 and `jq` if you want to run things
outside containers.

### Everything in containers (the one-command path)

```bash
docker compose up --build
```

That starts Postgres, Redis and RabbitMQ, waits for them to pass healthchecks, runs a
one-shot `migrate` container (`prisma migrate deploy` then the seed), and only then starts
the API and worker. When it settles:

```bash
curl -s localhost:3000/readyz
# {"status":"ready","db":"up","cache":"up"}
```

| Service | URL | Login |
|---|---|---|
| **Web UI** | http://localhost:5173 | seeded accounts are one-click buttons |
| API | http://localhost:3000 | JWT — see below |
| Adminer (browse the DB) | http://localhost:8080 | server `postgres`, user `icp`, pass `icp` |
| RabbitMQ management | http://localhost:15672 | `icp` / `icp` |

Seeded users, one per role — `admin@icp.local` / `admin12345`,
`operator@icp.local` / `operator12345`, `viewer@icp.local` / `viewer12345`.
Also seeded: cluster `us-east-1a`, racks `R01` and `R02`, and three spare unattached GPUs.

### Locally, with only the infrastructure in Docker

Better for development — you get hot reload and readable logs.

```bash
cp .env.example .env
docker compose up -d postgres redis rabbitmq
npx prisma migrate dev          # applies migrations + generates the client
npm run seed
npm run dev:api                 # terminal 1
npm run dev:worker              # terminal 2
```

For the UI, in a third terminal:

```bash
cd web && npm install && npm run dev    # http://localhost:5173
```

Vite proxies `/api/*` to `localhost:3000`, which is the same rewrite nginx performs in the
container image — so the app runs identically either way, with no API URL to configure.

### Tests

```bash
npm test                        # 13 unit tests, no services needed
RUN_INTEGRATION=1 npm test      # 24 tests, against real Postgres + RabbitMQ
npm run typecheck && npm run lint
cd web && npm run build         # typechecks the UI, then bundles it
```

The integration suite is the part worth pointing at: it asserts the four claims rather than
restating them. It fires two genuinely concurrent status updates and checks that exactly one
succeeds and the version increments exactly once; it checks an illegal transition leaves the
row untouched; it checks a duplicate GPU serial leaves no orphan node.

### Useful knobs

| Variable | Default | What it does |
|---|---|---|
| `PROVISION_DELAY_MS` | `3000` (compose) | How long the worker pretends hardware takes |
| `PROVISION_FAILURE_RATE` | `0` | Fraction of provisioning attempts that fail — set to `1` to demo the failure path |
| `RATE_LIMIT_MAX` | `100` | Requests per window per IP |
| `LOG_LEVEL` | `info` | `debug` to see everything |

```bash
PROVISION_FAILURE_RATE=1 docker compose up -d --force-recreate worker
```

---

## 3. How the data flows

### The synchronous path — a status change

This is the optimistic-locking story. `PATCH /nodes/:id/status` with `{status, version}`:

```
Client
  │  PATCH /nodes/:id/status  {"status":"MAINTENANCE","version":3}
  ▼
rate limit (Redis, keyed by IP)          ← before auth, so no identity yet
  ▼
authorize(ADMIN, OPERATOR)               ← verifies JWT, checks role
  ▼
Zod parses body                          ← malformed input dies here, 400
  ▼
updateNodeStatus()  ── BEGIN ────────────────────────────────────┐
  │  1. read node (must exist, not soft-deleted)                 │
  │  2. version matches what the client sent?      else 409      │
  │  3. transition legal per the state machine?    else 422      │
  │  4. UPDATE ... WHERE id = $1 AND version = $2                │
  │       0 rows → someone committed first → 409                 │
  │  5. INSERT lifecycle_event  (same transaction)               │
  └─ COMMIT ───────────────────────────────────────────────────  ┘
  ▼
publishEvent(NodeStatusChanged)          ← AFTER commit, never inside
  ▼
200  {status, version: 4, previousStatus, allowedTransitions}
```

Step 2 and step 4 look redundant. They aren't: step 2 gives a clean error with the current
version, and step 4 is the actual guarantee — the window between the read and the write is
where a lost update would happen, and the `WHERE version = $2` predicate closes it. The
`0 rows` branch is the one that survives a real race.

The audit event shares the transaction with the status change, which is what makes the trail
trustworthy: there is no way to change a status without recording it, and no way to record
an event for a change that didn't commit.

### The asynchronous path — provisioning a node

```
Client                      API                  RabbitMQ            Worker              Postgres
  │  POST /nodes             │                       │                  │                    │
  ├─────────────────────────►│                       │                  │                    │
  │                          │ 1. Zod validate       │                  │                    │
  │                          │ 2. INSERT job (QUEUED)│──────────────────┼───────────────────►│
  │                          │ 3. publish command    │                  │                    │
  │                          ├──────────────────────►│                  │                    │
  │  202 {jobId, poll}       │                       │                  │                    │
  │◄─────────────────────────┤                       │                  │                    │
  │                          │                       │  job.provision   │                    │
  │                          │                       ├─────────────────►│                    │
  │  GET /jobs/:id           │                       │                  │ 4. job → RUNNING   │
  ├─────────────────────────►│  RUNNING              │                  │                    │
  │                          │                       │                  │ 5. BEGIN           │
  │                          │                       │                  │    node CREATED    │
  │                          │                       │                  │    audit event     │
  │                          │                       │                  │    GPUs createMany │
  │                          │                       │                  │    → PROVISIONING  │
  │                          │                       │                  │    audit event     │
  │                          │                       │                  │    link job.nodeId │
  │                          │                       │                  │    COMMIT ────────►│
  │                          │                       │                  │                    │
  │                          │                       │                  │ 6. sleep(delay)    │
  │                          │                       │                  │    ← NO tx open    │
  │                          │                       │                  │                    │
  │                          │                       │                  │ 7. → ACTIVE        │
  │                          │                       │                  │    job SUCCEEDED   │
  │                          │                       │◄─────────────────┤ NodeProvisioned    │
  │  GET /jobs/:id           │                       │                  │                    │
  ├─────────────────────────►│  SUCCEEDED + nodeId   │                  │                    │
  │◄─────────────────────────┤                       │                  │                    │
                                                     │  (audit consumer observes the events)
```

Three ordering decisions in there are worth calling out, because they're the difference
between this working and merely appearing to work:

- **Job row before publish** (step 2 before 3). If the publish fails, there's a recoverable
  `QUEUED` row. Publish-first risks a worker picking up a job the API never recorded.
- **One transaction for the inventory write** (step 5). The node, its GPUs and both audit
  events commit together. A duplicate GPU serial takes the node row down with it.
- **The slow part is outside it** (step 6). No transaction is open while we wait.

The version arithmetic is a detail that confuses people in demos, so: the node is created at
`version 1`, the move to `PROVISIONING` makes it `2`, and the move to `ACTIVE` makes it `3`.
A freshly provisioned node reads `version: 3` — that's the number to use in a locking demo.

### When provisioning fails

The `catch` in `provisionNode` does three things: marks the job `FAILED` with the error and
increments `retries`, moves the node from `PROVISIONING` to `FAILED` so it doesn't sit
"in progress" forever, and publishes `NodeProvisioningFailed`. `FAILED` isn't terminal — the
state machine allows `FAILED → PROVISIONING`, so a retry is a legal move.

### Queue topology

```
icp.commands (direct)                     icp.events (topic)
  │ job.provision_node                      │ node.NodeProvisioned
  │ job.decommission_node                   │ node.NodeStatusChanged
  ▼                                         │ node.GpuAttached
icp.jobs  ──► worker (prefetch: 1)          │ node.NodeProvisioningFailed
                                            ▼  bound with '#'
                                       icp.events.audit ──► worker (audit consumer)
```

Both the API and the worker declare this topology on boot. Declaration is idempotent, so
neither has to start first.

---

## 4. Every file in `src/`

1,419 lines total. Bottom-up, in the order that makes the dependencies read naturally.

### Foundation

**`config.ts`** (33) — Parses `process.env` through a Zod schema and **throws on boot** if
anything is missing or malformed. `JWT_SECRET` has a minimum length. This is the "fail fast,
loudly, at startup" pattern: a missing variable becomes a clear crash on line one instead of
a mysterious `undefined` three hours into a deploy. Everything else imports `config`, never
`process.env`.

**`logger.ts`** (11) — One Pino instance. Structured JSON in production, pretty-printed in
development. `base` tags every line with the service name so API and worker logs are
distinguishable when interleaved. `redact` strips `authorization` headers, `password` and
`*.passwordHash` — credentials in logs are a real incident, and the fix belongs at the
logger, not at each call site.

**`prisma.ts`** (9) — The `PrismaClient` singleton, plus the `notDeleted` constant
(`{ deletedAt: null }`). Exporting the filter as one shared value means no route can forget
it and accidentally return deleted rows.

**`redis.ts`** (7) — The Redis client, used for rate limiting and by `/readyz`. Note
`import { Redis }`, not a default import — the default doesn't give a constructor under
NodeNext ESM resolution.

**`queue.ts`** (109) — All RabbitMQ concerns. Declares the two exchanges and two queues,
exports the `DomainEvent` union (a discriminated union, so consumers get exhaustive
type-checking), and provides `publishCommand`, `publishEvent` and `consume`. `initQueue` is
idempotent and cached. `consume` acks in a `finally` — the handler owns durable outcome
recording via the job row, so retries are a deliberate decision rather than an accident of
redelivery.

### Domain — the business rules, with no I/O

**`domain/lifecycle.ts`** (39) — The node state machine as a single `ALLOWED_TRANSITIONS`
table, plus `canTransition`, `assertTransition` and `isTerminal`. Typed as
`Record<NodeStatus, ...>`, so adding a status to the Prisma enum makes this file fail to
compile until the new state's transitions are defined. This is the file to open first when
explaining the project — it's the whole domain in 39 lines, and both the API and the worker
depend on it.

**`domain/errors.ts`** (54) — An `AppError` base carrying `statusCode`, a stable machine
`code`, and structured `details`, with a subclass per failure mode. The details are the
useful part: `VersionConflictError` returns `{expectedVersion, currentVersion}` so a client
can re-read and retry, and `InvalidTransitionError` returns `{from, to, allowed}` so a
client doesn't have to hardcode the graph. Errors carry their own HTTP status, so services
can throw domain errors without knowing anything about HTTP.

### Services — the transactional core

**`services/nodeService.ts`** (163) — The most important file in the project.
`updateNodeStatus` is where optimistic locking, the state machine, the audit trail and
transactions all meet; the [synchronous flow](#the-synchronous-path--a-status-change) above
is a line-by-line description of it. Also here: `recordLifecycleEvent` (insert-only, takes a
`Db` that's either a transaction or the client so it works in both),
`retireAndSoftDeleteNode` (records the RETIRED event, detaches GPUs back to the free pool,
sets `deletedAt`), and `getNodeHistory` — deliberately *not* filtered by `deletedAt`,
because history outlives the node.

**`services/provisioningService.ts`** (207) — The async workload. Holds
`provisionPayloadSchema` (shared with the routes, so the API and the worker agree on what a
valid request is) and `jobMessageSchema`, which re-validates the message coming off the
queue — it crossed a process boundary, so it's untrusted regardless of who enqueued it.
`provisionNode` is the three-step dance: atomic inventory write, slow work outside any
transaction, then publish the outcome. The `catch` implements the failure path.

**`services/jobService.ts`** (39) — `enqueueProvisionJob` persists the job row **then**
publishes the command, in that order and for the reason described above. `getJob` for
polling. Small file, one important decision.

### HTTP plumbing

**`http/errorHandler.ts`** (87) — One place that turns every failure into the same envelope:
`{ error: { code, message, details?, correlationId } }`. Maps `AppError` by its own status,
`ZodError` → 400 with field paths, Prisma `P2002` → 409, `P2003`/`P2025` → 404, JWT errors →
401, rate limits → 429. Unknown 5xx errors log the real error and return a generic message —
internals don't leak to clients. Also a `setNotFoundHandler` so a typo'd URL returns the
same shape as everything else.

**`http/pagination.ts`** (34) — Keyset pagination in three small pieces: `pageQuerySchema`
(limit 1–100, default 20), `keyset()` (asks for `limit + 1` rows — the extra row is how we
know another page exists, without a second `COUNT` query), and `toPage()` (trims the probe
row and returns `{data, page: {limit, hasMore, nextCursor}}`).

**`auth/plugin.ts`** (53) — Registers `@fastify/jwt` and decorates the instance with
`authenticate` (valid token required) and `authorize(...roles)` (valid token *and* one of
these roles). RBAC is therefore one declarative line per route:
`preHandler: [app.authorize(Role.ADMIN)]`. Also `actorOf(req)`, which extracts the email to
attribute audit events to, and the TypeScript module augmentation that makes `req.user`
typed rather than `any`.

### Routes — thin by design

Each route validates, delegates to a service, and shapes the response. Business logic lives
in `services/` and `domain/`, so nothing important is duplicated across endpoints or
unreachable from the worker.

**`routes/nodes.ts`** (125) — The interesting one. `POST /nodes` → 202 + job (never blocks);
`PATCH /nodes/:id/status` → the optimistic-locking endpoint; `GET /nodes/:id` → includes
`allowedTransitions` so a UI can grey out illegal buttons; `GET /nodes/:id/history` → the
audit trail; `DELETE` → soft delete.

**`routes/clusters.ts`** (82) — Full CRUD, admin-only for writes. The delete path refuses to
remove a cluster that still has racks (409 with the count) rather than orphaning them.

**`routes/racks.ts`** (41) — Create and list, with a filtered `_count` of non-deleted nodes.

**`routes/gpus.ts`** (84) — Create (optionally attached to a node, refused if that node is
retired) and list with filters. `unassigned=true` returns spare inventory; it's parsed with
an explicit `z.enum(['true','false'])` transform because `z.coerce.boolean()` reads the
string `"false"` as `true`.

**`routes/jobs.ts`** (36) — `POST /jobs` (a generic async entry point) and `GET /jobs/:id`,
which is what clients poll after a 202.

**`routes/auth.ts`** (31) — `POST /auth/login` issues a JWT; `GET /auth/me` echoes the token
claims. Login compares against a dummy bcrypt hash when the email is unknown, so response
timing doesn't reveal which accounts exist.

**`routes/health.ts`** (21) — `/healthz` is liveness: is the process up? No dependencies, so
a database blip can't get the container killed and restarted pointlessly. `/readyz` is
readiness: it pings Postgres and Redis and returns 503 when degraded, so a load balancer
takes the instance out of rotation instead of failing user requests.

### Composition and entrypoints

**`app.ts`** (60) — Builds the Fastify instance and registers everything in order: rate limit
→ auth → error handler → routes. Two details worth defending in an interview. First,
`genReqId` honours an inbound `x-correlation-id`, so one id follows a request across the API,
into the queue message, and out through the worker's logs. Second, the rate limiter is
Redis-backed (so the limit is shared across replicas rather than multiplied by the replica
count) and keyed on `req.ip` rather than the user — the hook runs at `onRequest`, before the
JWT is verified, so bucketing on an unverified token's `sub` would let a forged token burn a
real user's quota.

`buildApp()` returns the app without listening, which is what lets the integration tests use
`app.inject()` — real routing, hooks and error handling, no port.

**`server.ts`** (38) — API entrypoint. Init queue, build app, listen, then handle
SIGTERM/SIGINT by closing the app **first** so in-flight requests drain before the
connections they depend on go away. A rolling deploy shouldn't 500 a request it already
accepted.

**`worker.ts`** (56) — Worker entrypoint. Runs two independent consumers in one process: the
job consumer (`prefetch: 1` — provisioning is the slow part, so throughput comes from more
replicas, not from buffering work in one) and the audit consumer, bound to `#`, which just
logs every event. That second consumer exists to make the decoupling visible: it reacts to
events the API published without the API ever knowing it exists.

### And `web/` — the frontend

Not part of `src/`, and deliberately kept at arm's length: its own `package.json`, its own
`tsconfig`, its own image. The root `Dockerfile` copies only `prisma`, `tsconfig.json` and
`src`, so the API build never sees the frontend, and the root lint/typecheck/test scripts are
unaffected.

| File | What it is |
|---|---|
| `api/client.ts` | The only place that calls `fetch`. Prefixes `/api`, attaches the bearer token, and turns the error envelope into a typed `ApiError` with `status`, `code` and `details`. A 401 clears the session and fires an event the auth provider listens for, so an expired hour-old token logs the UI out instead of leaving it half-authenticated. Sets `content-type` only when there is a body — Fastify rejects an empty body that claims to be JSON. |
| `api/types.ts` | Hand-written mirrors of the response shapes and enums. Documents which fields the UI actually depends on, which generated types don't. |
| `auth/AuthContext.tsx` | Token and user in `localStorage`, exposed as `useAuth()` with `can(...roles)`. |
| `hooks/useApi.ts` | ~25 lines: `loading` / `data` / `error` / `reload`. No caching library, on purpose — a stale cache is actively misleading in a demo about concurrent writes. Ignores a response that resolves after its dependencies changed, so a slow request can't overwrite a newer one. |
| `pages/NodeDetailPage.tsx` | The centrepiece. Renders the server's `allowedTransitions` as buttons (never a client-side copy of the graph), always PATCHes the version currently on screen, and turns a 409 into a first-class banner rather than a toast. |
| `pages/ProvisionPage.tsx` | The 202 + polling flow. Polls once a second and stops on a terminal status — the limiter allows 100 requests/minute per IP and behind nginx every browser shares one bucket, so an unbounded interval would eventually spend it. |
| `nginx.conf` | Serves the bundle, falls back to `index.html` for client-side routes, and proxies `/api/` to `api:3000`. |

No API URL is baked into the bundle — the app calls relative paths — so the image is
identical in every environment.

---

## 5. Demoing it to someone

A 10-minute version. Have three things on screen: a terminal, `docker compose logs -f
worker`, and Adminer or the RabbitMQ UI.

### Or do it in the browser

The same seven beats, clickable. Recommended for a non-engineer audience, or when you want to
talk instead of typing — keep `docker compose logs -f worker` visible either way, because the
worker log is what proves the async part is real.

| Beat | Where | What to point at |
|---|---|---|
| 1 — the pitch | any page | The nav *is* the hierarchy: clusters → racks → nodes → GPUs. |
| 2 — async provisioning | **Provision** | Submit, and note the response is 202 with a job id, not a node. The QUEUED → RUNNING → SUCCEEDED strip fills in over ~3 seconds while the page just polls. |
| 3 — optimistic locking | **Node detail**, two tabs | Open the same node twice. Act in tab 1, then act in tab 2: tab 2 shows `you sent v3 / current v4` and its write is refused. "Nothing was lost — the second writer was told to re-read." |
| 4 — the state machine | **Node detail** | The buttons come from the server's `allowedTransitions`. Expand "force an illegal transition", pick `CREATED`, send: 422, with the legal moves listed and the row untouched. |
| 5 — transactional integrity | **Provision** | Click "Use a duplicate serial" and submit. The job ends FAILED, and the node list is unchanged — no half-built node, no orphan GPU. |
| 6 — RBAC | sign out, sign in as **VIEWER** | Every write control is disabled, and the banner says the server enforces it independently. All the data is still browsable. |
| 7 — history outlives the row | **Node detail** of a deleted node | The node 404s; the audit trail still renders. |

The one thing to say out loud on beat 3: the page sends the version it is *displaying*. That
is why a stale tab produces a real conflict instead of silently clobbering — and it's why a
freshly provisioned node is already on version 3, having gone created → PROVISIONING → ACTIVE.

### Setup

```bash
docker compose up --build -d
curl -s localhost:3000/readyz          # wait for {"status":"ready",...}

TOKEN=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@icp.local","password":"admin12345"}' | jq -r .token)
AUTH="authorization: Bearer $TOKEN"
RACK=$(curl -s localhost:3000/racks -H "$AUTH" | jq -r '.data[0].id')
```

### Beat 1 — the pitch (1 min)

"It's the control plane a cloud provider runs to manage its own hardware — clusters, racks,
nodes, GPUs. The hardware is simulated, because the point is the engineering around it: four
specific production failure modes, each with a fix, each with a test that fails if the fix
is removed." Open `src/domain/lifecycle.ts` — 39 lines, and it's the entire domain.

### Beat 2 — async provisioning (2 min)

"Provisioning real hardware takes minutes, so the API never waits for it."

```bash
JOB=$(curl -s -X POST localhost:3000/nodes -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"rackId\":\"$RACK\",\"hostname\":\"demo-node-01\",\"cpu\":\"EPYC 9654\",\"memoryMb\":786432,
       \"gpus\":[{\"vendor\":\"NVIDIA\",\"model\":\"H100\",\"memoryMb\":81920,\"serialNumber\":\"SN-DEMO-9001\"}]}" \
  | jq -r .jobId)

curl -s localhost:3000/jobs/$JOB -H "$AUTH" | jq '{status,nodeId}'   # QUEUED or RUNNING, nodeId null
sleep 5
curl -s localhost:3000/jobs/$JOB -H "$AUTH" | jq '{status,nodeId}'   # SUCCEEDED + nodeId
```

Point at the worker log while it runs. The 202 came back instantly; the work happened
somewhere else. Mention that the job row is written before the message is published, so a
broker hiccup leaves recoverable state.

### Beat 3 — optimistic locking (3 min, the centrepiece)

"Two operators, same node, same moment. Without this, one silently wins."

```bash
NODE=$(curl -s localhost:3000/jobs/$JOB -H "$AUTH" | jq -r .nodeId)
V=$(curl -s localhost:3000/nodes/$NODE -H "$AUTH" | jq -r .version)
echo "both operators read version $V"

curl -s -X PATCH localhost:3000/nodes/$NODE/status -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"status\":\"MAINTENANCE\",\"version\":$V}" | jq '{status,version}'

curl -s -X PATCH localhost:3000/nodes/$NODE/status -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"status\":\"FAILED\",\"version\":$V}" | jq '.error'
```

The first returns 200 and bumps the version. The second returns
`VERSION_CONFLICT` with `{"expectedVersion":3,"currentVersion":4}` — enough for the client
to re-read and retry. Then show the `updateMany` in `nodeService.ts:76` and explain that the
guard is the `WHERE version = $2` predicate, not the read above it, because the read-then-write
window is exactly where a lost update lives.

If they push on it — "how do you know it actually handles a real race?" — that's the test at
`tests/integration/controlPlane.test.ts`: two concurrent `updateNodeStatus` calls via
`Promise.allSettled`, asserting exactly one fulfils, one rejects, and the version increments
exactly once.

### Beat 4 — the state machine and the audit trail (2 min)

```bash
curl -s -X PATCH localhost:3000/nodes/$NODE/status -H "$AUTH" -H 'content-type: application/json' \
  -d '{"status":"CREATED","version":4}' | jq '.error.details'
# {"from":"MAINTENANCE","to":"CREATED","allowed":["ACTIVE","FAILED","RETIRED"]}

curl -s localhost:3000/nodes/$NODE/history -H "$AUTH" \
  | jq -c '.events[] | {oldStatus,newStatus,actor,reason}'
```

422, the row is untouched, and the error tells the client what *is* legal. Then the history:
every transition, in order, with who did it — written in the same transaction as the change,
so it can't drift. Add the soft-delete twist: after `DELETE /nodes/:id`, the node 404s but
its `/history` still answers, because history outlives the node.

### Beat 5 — transactional integrity (1 min)

"Provisioning writes a node, its GPUs and two audit events. Either all of it lands or none."

```bash
curl -s -X POST localhost:3000/nodes -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"rackId\":\"$RACK\",\"hostname\":\"demo-node-02\",\"cpu\":\"EPYC\",\"memoryMb\":1024,
       \"gpus\":[{\"vendor\":\"NVIDIA\",\"model\":\"H100\",\"memoryMb\":81920,\"serialNumber\":\"DUP-1\"},
                 {\"vendor\":\"NVIDIA\",\"model\":\"H100\",\"memoryMb\":81920,\"serialNumber\":\"DUP-1\"}]}" \
  | jq -r .jobId
sleep 3
curl -s 'localhost:3000/nodes?hostname=demo-node-02' -H "$AUTH" | jq '.data | length'   # 0
```

The duplicate serial rolls the node back with it — no server with missing hardware. Note the
counterpoint: the *slow* part deliberately runs outside the transaction, because holding one
open for ten minutes would pin a connection and block vacuum.

### Beat 6 — RBAC and the event fan-out (1 min)

```bash
VT=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"viewer@icp.local","password":"viewer12345"}' | jq -r .token)
curl -s -o /dev/null -w 'viewer GET:  %{http_code}\n' localhost:3000/nodes -H "authorization: Bearer $VT"
curl -s -o /dev/null -w 'viewer POST: %{http_code}\n' -X POST localhost:3000/nodes \
  -H "authorization: Bearer $VT" -H 'content-type: application/json' -d '{}'

docker compose logs worker | grep "event observed"
```

200 then 403. Then the events: the API published `NodeProvisioned`, `NodeStatusChanged`,
`GpuAttached` to a topic exchange and never named a consumer — the worker's audit consumer
picked them up by binding `#`. Adding billing means binding another queue and touching no
existing code. Show the exchange bindings in the RabbitMQ UI if there's time.

### Beat 7 — the failure path (1 min)

```bash
PROVISION_FAILURE_RATE=1 docker compose up -d --force-recreate worker
sleep 6
# provision anything; the job ends FAILED with retries: 1, and the node lands in
# FAILED rather than sticking in PROVISIONING forever
```

Then reset: `docker compose up -d --force-recreate worker`.

### Closing

Two things to say at the end. First: `RUN_INTEGRATION=1 npm test` — 24 tests, and the
integration ones assert these properties rather than restating them. Second, name the gaps
before they're asked about: `POST /nodes` isn't idempotent (a double-click makes two jobs),
and failed jobs increment `retries` but nothing re-dispatches them — the real version needs
an idempotency-key table and retry-with-backoff into a dead-letter queue. Both are in the
README's "Deliberately not implemented" list. Naming the scope you cut reads better than
letting someone discover it.

### Likely questions

| Question | Answer |
|---|---|
| Why optimistic and not `SELECT FOR UPDATE`? | Conflicts on one node are rare, and pessimistic locks hold a transaction across user think-time. Cheaper to detect and retry. |
| What if the worker dies mid-job? | The job stays `RUNNING`. That's a known gap — the fix is a lease/heartbeat plus a reaper that fails out stale jobs. Nothing is corrupted, because the node is in `PROVISIONING` and the transition out of it is guarded. |
| Why re-validate the queue message? | It crossed a process boundary. Whatever the API validated, the worker can't assume — someone could publish directly to the exchange. |
| Why not publish inside the transaction? | A consumer could see an event for work that then rolled back. Publish-after-commit trades a small window of "committed but not published" for never lying to consumers. |
| Why soft delete? | Hardware inventory is an audit surface. History and serial numbers survive; the row disappears from reads. |
| How would you scale it? | `docker compose up --scale worker=3`. Workers are `prefetch: 1`, so throughput is replicas; optimistic locking keeps their writes honest. The API is stateless, and the rate limiter is in Redis so it's shared. |
