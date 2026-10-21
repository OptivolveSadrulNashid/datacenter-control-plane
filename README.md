# Infrastructure Control Plane

A backend control plane that manages the lifecycle of datacenter infrastructure —
**clusters → racks → nodes → GPUs** — the way a cloud provider's internal platform does.
No real hardware is provisioned; the point is the engineering around it: concurrency
control, asynchronous work, an immutable audit trail, and transactional consistency.

```
                    ┌─────────┐
                    │  React  │  nginx serves the SPA and proxies /api
                    │   SPA   │  (same origin, so no CORS)
                    └────┬────┘
                         │  JWT
                    ┌────▼────┐
                    │ Fastify │  validation · RBAC · rate limit · 202 Accepted
                    │   API   │
                    └──┬───┬──┘
          ┌────────────┘   └──────────┐
   ┌──────▼─────┐              ┌──────▼──────┐    ┌───────┐
   │ PostgreSQL │              │  RabbitMQ   │    │ Redis │
   │  (Prisma)  │              │ commands +  │    │ rate  │
   └──────▲─────┘              │   events    │    │ limit │
          │                    └──────┬──────┘    └───────┘
          │                    ┌──────▼──────┐
          └────────────────────┤   Worker    │  provisioning · event consumer
                               └─────────────┘
```

## Quickstart

```bash
docker compose up --build          # migrates, seeds, then starts api + worker + web
```

Then open **<http://localhost:5173>** and sign in — the login screen lists the seeded
accounts as one-click buttons.

| Service | URL | Credentials |
|---|---|---|
| Web UI | http://localhost:5173 | see below |
| API | http://localhost:3000 | see below |
| Adminer (DB browser) | http://localhost:8080 | server `postgres`, `icp` / `icp` |
| RabbitMQ management | http://localhost:15672 | `icp` / `icp` |

Seeded users — one per role:

| Email | Password | Role |
|---|---|---|
| `admin@icp.local` | `admin12345` | ADMIN |
| `operator@icp.local` | `operator12345` | OPERATOR |
| `viewer@icp.local` | `viewer12345` | VIEWER |

Running outside Docker: `cp .env.example .env`, `docker compose up -d postgres redis
rabbitmq`, then `npx prisma migrate dev`, `npm run seed`, `npm run dev:api`, `npm run dev:worker`,
and `cd web && npm install && npm run dev`.

## Web UI

A small React SPA (`web/`) so the behaviours below can be *shown* rather than read. It's a
viewer over the whole inventory plus the four headline demos as clickable actions:

| Screen | What it demonstrates |
|---|---|
| **Provision** | `POST /nodes` returns 202, then the page polls the job through QUEUED → RUNNING → SUCCEEDED and links to the node it created. One button sets a GPU serial that already exists, so you can watch the whole transaction roll back. |
| **Node detail** | Buttons are built from the API's `allowedTransitions`, so the UI never copies the state machine. A stale page submitting an old `version` gets a 409 banner showing `you sent v3 / current v4`. A collapsed "force an illegal transition" control sends any status you pick, to see the 422. |
| **Node detail (deleted)** | Open a soft-deleted node: the node 404s, but its audit trail still renders — history outlives the row. |
| **Any screen, as viewer** | Write controls are disabled, and the banner says why the server is still the real guard. |

The browser only ever calls same-origin `/api/*` paths: Vite's dev server proxies them in
development and nginx does the same in the image, so the API needs no CORS configuration and
the bearer token never crosses an origin. Building the image runs `tsc --noEmit` first, so a
type error fails the build rather than shipping.

## API

All routes except `/healthz`, `/readyz` and `/auth/login` need `Authorization: Bearer <token>`.

| Method | Path | Role |
|---|---|---|
| POST | `/auth/login` | — |
| GET | `/auth/me` | any |
| POST · PATCH · DELETE | `/clusters` · `/clusters/:id` | ADMIN |
| GET | `/clusters` · `/clusters/:id` | any |
| POST | `/racks` | ADMIN |
| GET | `/racks?clusterId=` | any |
| POST | `/nodes` → **202 + job** | ADMIN, OPERATOR |
| GET | `/nodes?status=&rackId=&hostname=` · `/nodes/:id` | any |
| PATCH | `/nodes/:id/status` | ADMIN, OPERATOR |
| DELETE | `/nodes/:id` (soft delete) | ADMIN |
| GET | `/nodes/:id/history` | any |
| POST | `/gpus` | ADMIN, OPERATOR |
| GET | `/gpus?vendor=&healthStatus=&unassigned=true` | any |
| POST | `/jobs` → **202** · GET `/jobs/:id` | ADMIN, OPERATOR / any |

Lists are cursor-paginated: `?limit=20&cursor=<last id>` → `{ data, page: { hasMore, nextCursor } }`.

## The five things this project actually demonstrates

### 1. Concurrent updates don't get lost — optimistic locking

Every node carries a `version`. A status change must declare the version it read, and the
guard is a predicate on the UPDATE itself (`src/services/nodeService.ts`):

```sql
UPDATE nodes SET status = $1, version = version + 1
WHERE id = $2 AND version = $3 AND deleted_at IS NULL;
```

Zero rows affected means someone else committed first → **409 `VERSION_CONFLICT`**, telling
the client the current version so it can re-read and retry. No row locks, no lost writes.

```bash
TOKEN=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@icp.local","password":"admin12345"}' | jq -r .token)
AUTH="authorization: Bearer $TOKEN"

# Both engineers read the same version...
V=$(curl -s localhost:3000/nodes/$NODE -H "$AUTH" | jq -r .version)

# ...and both submit it:
curl -s -X PATCH localhost:3000/nodes/$NODE/status -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"status\":\"MAINTENANCE\",\"version\":$V}"   # 200, version becomes $V+1
curl -s -X PATCH localhost:3000/nodes/$NODE/status -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"status\":\"FAILED\",\"version\":$V}"        # 409 VERSION_CONFLICT
# → {"code":"VERSION_CONFLICT","details":{"expectedVersion":3,"currentVersion":4}}
```

### 2. Slow work doesn't hold an HTTP request open

`POST /nodes` doesn't provision anything. It records the intent as a `Job`, publishes a
command to RabbitMQ, and returns **202** with somewhere to poll. The worker does the work.

```bash
JOB=$(curl -s -X POST localhost:3000/nodes -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"rackId\":\"$RACK\",\"hostname\":\"gpu-node-01\",\"cpu\":\"EPYC 9654\",\"memoryMb\":786432,
       \"gpus\":[{\"vendor\":\"NVIDIA\",\"model\":\"H100\",\"memoryMb\":81920,\"serialNumber\":\"SN-001\"}]}" \
  | jq -r .jobId)

curl -s localhost:3000/jobs/$JOB -H "$AUTH" | jq   # QUEUED → RUNNING → SUCCEEDED
```

The job row is written **before** the message is published, so a failed publish leaves a
recoverable `QUEUED` job rather than a message referencing a job that was never saved.

### 3. Status history is never overwritten

Each transition appends a row to `lifecycle_events`, which is only ever inserted into.
The event and the status change share one transaction, so the trail can't drift from reality.

```bash
curl -s localhost:3000/nodes/$NODE/history -H "$AUTH" | jq '.events[] | {oldStatus,newStatus,actor}'
```

History survives deletion: `DELETE /nodes/:id` sets `deleted_at` (the node disappears from
reads and returns 404), but `/history` still answers.

### 4. Business rules are enforced, not assumed

Transitions run through an explicit state machine (`src/domain/lifecycle.ts`) that both the
API and the worker share:

```
CREATED → PROVISIONING → ACTIVE ⇄ MAINTENANCE
                 ↓          ↓          ↓
               FAILED ←─────┴──────────┘
                 ↓
              RETIRED  (terminal)
```

`CREATED → ACTIVE` is rejected with **422 `INVALID_TRANSITION`**, listing what *is* legal —
and the row is never touched. `GET /nodes/:id` returns `allowedTransitions` so clients
don't have to hardcode the graph.

### 5. Partial writes are impossible

Provisioning creates a node, its GPUs, and two audit events. All of it is one transaction
(`src/services/provisioningService.ts`), so a duplicate GPU serial number rolls the node
back with it — never a node whose hardware is missing.

The slow simulated hardware call deliberately runs **outside** the transaction. Holding a
Postgres transaction open for a ten-minute operation would pin a connection and block
vacuum; instead the node sits in `PROVISIONING`, visible to readers, until it resolves.

Try the failure path: set `PROVISION_FAILURE_RATE=1`, restart the worker, provision again.
The job ends `FAILED` and the node lands in `FAILED` rather than sticking in `PROVISIONING`.

### Bonus: nothing calls the consumers

The API publishes `NodeProvisioned`, `NodeStatusChanged`, `GpuAttached` to a topic exchange
and never names a consumer. The worker's audit consumer binds `#` and observes them
(`docker compose logs worker`). Adding billing or notifications means binding another
queue — no change to the publisher. Events are published only **after** commit, so no
consumer ever sees work that rolled back.

## Testing

```bash
npm test                     # unit: state machine + pagination, no services needed
RUN_INTEGRATION=1 npm test   # + integration against real Postgres and RabbitMQ
```

The integration suite (`tests/integration/controlPlane.test.ts`) asserts the claims above
rather than restating them: the lost update never lands, two genuinely concurrent writes
produce exactly one version increment, an illegal transition leaves the row untouched, a
viewer gets 403 on writes, and a duplicate GPU serial leaves no orphan node.

## Operational notes

- **Observability** — structured Pino logs; a correlation id per request (`x-correlation-id`,
  honoured if the client sends one) that flows into the queue message and the worker's logs.
- **Health** — `/healthz` is liveness (no dependencies); `/readyz` checks Postgres and Redis
  and returns 503 when degraded, so a load balancer pulls the instance rather than failing
  requests.
- **Shutdown** — SIGTERM drains in-flight requests before closing the DB and queue.
- **Scaling** — `docker compose up --scale worker=3`. Workers are `prefetch: 1`, so
  throughput comes from replicas; optimistic locking keeps their writes honest.
- **Indexes** — `nodes(status)`, `nodes(status, deleted_at)`, `nodes(hostname)` unique,
  `racks(cluster_id)`, `gpus(vendor, health_status)`, `lifecycle_events(node_id, created_at)`.
- **Errors** — every failure returns one envelope: `{ error: { code, message, details, correlationId } }`.

## Deliberately not implemented

Scoped out to keep this readable, not because they're unimportant:

- **Idempotency keys** — `POST /nodes` isn't idempotent; a double-click creates two jobs.
  The fix is an `idempotency_keys` table storing the key and first response.
- **Retries and a dead-letter queue** — a failed job is marked `FAILED` and its `retries`
  column is incremented, but nothing re-dispatches it. Real version: retry with exponential
  backoff, then a DLQ.
- **Redis response caching** — Redis is only backing the rate limiter here.
- **A hardened session for the UI** — the SPA keeps its JWT in `localStorage`, which any XSS
  on the page can read. The production answer is an httpOnly, `SameSite=Strict` cookie plus
  CSRF protection; that needs a login endpoint that sets cookies, so it was left out rather
  than half-done.
- **Per-user rate limiting behind the proxy** — Fastify runs with `trustProxy` off, so every
  browser request through nginx shares one bucket keyed on the proxy's address. Trusting a
  client-settable `X-Forwarded-For` would make the limiter trivially bypassable, so the
  shared bucket is the deliberate choice at this scale.
- **Frontend tests** — `npm run build` typechecks the UI, and that is the only automated
  guard on it.
- **Prometheus / Grafana / Kubernetes / distributed tracing.**
