# Galactic Mining League

A sample leaderboard application built on **Amazon ElastiCache** (Valkey 9.0 with durability) demonstrating how a single durable data store can serve as both the real-time leaderboard engine *and* the persistent profile store — no separate database needed.

## Why Valkey for Leaderboards?

A leaderboard sounds simple until you need all of these *simultaneously*:

| Operation | Valkey Sorted Set | DynamoDB | PostgreSQL |
|---|---|---|---|
| "What rank is user X?" | `ZREVRANK` — O(log N) | No native operation. Scan & count, or maintain a separate counter. | `SELECT COUNT(*) WHERE score > X` — full index scan |
| "Show me ranks 50–100" | `ZRANGEWITHSCORES 50 99` — O(log N + 50) | Query + GSI, but no stable rank across pages | `OFFSET 50 LIMIT 50` — re-sorts every query |
| "Add 350 points atomically" | `ZINCRBY` — single atomic op, no read-modify-write | `ADD` on UpdateItem works, but reading rank requires a second call | `UPDATE SET score = score + 350` — row lock |
| "Only keep their best score" | `ZADD GT` — conditional replace in one command | ConditionalExpression with read-before-write | `UPDATE SET score = GREATEST(score, $1)` — works but no rank |
| "How many users scored above 10K?" | `ZCOUNT` — O(log N) | FilterExpression on Scan — reads everything | `SELECT COUNT(*) WHERE score > 10000` — index scan |
| "Prune to top 500" | `ZREMRANGEBYRANK` — one command | BatchDeleteItem with scan | Subquery + DELETE — expensive |
| "50 concurrent writers, same board" | Lock-free, atomic — just works | Hot partition risk on high-velocity items | Row-level locks, connection pool pressure |

The sorted set gives you all of these in **one data structure** with **sub-millisecond latency**. Everything else requires you to build, maintain, and pay for the answer to "what rank am I?" as a separate system.

## What's New: ElastiCache Durability

With [ElastiCache durability](https://aws.amazon.com/about-aws/whats-new/2026/06/durability-amazon-elasticache/) (Valkey 9.0+), data is stored durably across multiple Availability Zones using a Multi-AZ transactional log. This means:

- **Data survives node failures, restarts, and failovers** — no more "cache-only" limitations
- **Synchronous writes** persist data across at least two AZs before responding — designed for zero data loss
- **Microsecond read latency maintained** — the performance you expect from ElastiCache

This eliminates the need for a separate durable store (like DynamoDB) for profile data. The Valkey hashes that previously served as a *cache layer* now **are** the source of truth. One service, one data model, one bill.

### Before (Two-Tier)
```
DynamoDB (profiles) → write-through → ElastiCache (rankings + cache)
```

### After (Single-Tier Durable)
```
ElastiCache Valkey 9.0 + Synchronous Durability (profiles + rankings + events)
```

## Valkey Features Demonstrated

### Core Sorted Set Operations

```
ZINCRBY galactic:leaderboard:alltime 350 ship-abc123
```
Atomic score increment. 100 concurrent Lambda workers calling this on the same key — no locks, no conflicts, no lost updates. The sorted set maintains rank ordering internally after every write.

```
ZADD galactic:leaderboard:alltime GT 480 ship-abc123
```
"Best score" mode — only replaces the stored value if the new one is higher. One command instead of read-compare-write. Useful for high-score tables, personal bests, speedrun boards.

```
ZRANGEWITHSCORES galactic:leaderboard:alltime 0 49 REV
```
Get ranks 1–50 with scores in a single call. O(log N + 50) regardless of whether the set has 100 or 10 million members.

```
ZREVRANK galactic:leaderboard:alltime ship-abc123
```
"What place am I?" — O(log N). Try answering this in DynamoDB without scanning the entire table.

### Hash as a Durable Profile Store

```
HSET ship:abc123 shipName "ISS Ironclad" pilotName "Zara Voss" shipClass "Excavator"
                 totalSimulations "8" lifetimeOreHauled "175970"
                 createdAt "2026-05-27T..." lastActiveAt "2026-06-01T..."
```

Ship identity and lifetime stats stored in Valkey hashes — **durably**. With ElastiCache durability enabled, these survive node failures and restarts. No separate database needed for profile persistence.

```
HINCRBY ship:abc123 totalSimulations 1
HINCRBY ship:abc123 lifetimeOreHauled 4200
```

Atomic counter increments directly on the hash. Workers update lifetime stats in-place after each simulation — one round-trip, no read-modify-write, no eventual consistency concerns.

When rendering a leaderboard page, batch-fetch metadata for all 50 entries in one pipeline — everything (rank, score, name, class, lifetime stats) comes from a single Valkey call.

### Time-Windowed Boards

Separate sorted set per time window — no schema changes, no migrations:

```
galactic:leaderboard:alltime            ← cumulative
galactic:leaderboard:daily:2026-05-27   ← resets each day
galactic:leaderboard:weekly:2026-W22    ← resets each week
```

Each write fans out to all three keys. Each key is independently queryable with its own pagination, filtering, and rank lookups.

### Score Threshold Filtering

```
ZCOUNT galactic:leaderboard:alltime 10000 +inf     → 847
ZRANGEBYSCORE galactic:leaderboard:alltime 10000 +inf REV LIMIT 0 50
```

"How many ships earned above 10K? Show me the top 50 of them." Two commands, no full scan.

### Top-N Cap (Bounded Leaderboards)

```
ZREMRANGEBYRANK galactic:leaderboard:alltime 500 -1
```

After every scoring tick, prune everyone below rank 500. The sorted set never grows unbounded.

### Pipelining (Batch)

```javascript
const batch = new Batch(false);  // non-atomic pipeline
for (const ship of ships) {
  batch.zincrby(alltimeKey, haul, ship.shipId);
  batch.zincrby(dailyKey, haul, ship.shipId);
  batch.zincrby(weeklyKey, haul, ship.shipId);
}
await client.exec(batch, false);  // one round-trip for 150+ ops
```

50 ships × 3 keys = 150 commands sent in a single network round-trip. Without pipelining, that's 150 sequential request-response cycles (~150 × 1ms = 150ms). With pipelining: ~4ms total.

### Streams as an Event Log

```
XADD galactic:events * type sim_start workerId 3 ships 50 duration 30
XADD galactic:events * type tick workerId 3 tick 12 opsThisTick 150
XADD galactic:events * type sim_complete workerId 3 totalUpdates 9000 p50 3.2
```

Workers emit events to a capped Valkey Stream on every lifecycle event (start, tick, complete). The stream auto-trims to ~1000 entries via `MAXLEN ~1000`.

The frontend polls incrementally:
```
GET /events?since=1779923235915-0&limit=20
```

Returns only events *after* the given stream ID — no re-reading old data.

### Ephemeral Session Cache (SET + EX)

```
SET session:sim-abc123 <JSON array of 2000 profiles> EX 360
```

When launching a simulation, the API stores the full profile list in Valkey with a TTL. Workers receive only `{sessionKey, startIndex, shipCount}` in their invoke payload (~200 bytes) and `GET` the session key to retrieve their slice. The key auto-expires after the simulation completes.

This solves:
- **Lambda payload limit** (256KB for async invoke) — 2000 profiles × ~200 bytes each = 400KB, won't fit in a single invoke
- **Redundant profile scans** — one scan, one `SET`, N `GET`s
- **Coordination-free sharing** — workers independently read the same key, slice their own chunk

## Architecture: Single-Tier Durable

```
┌─────────────────────────────────────────────────────────────────┐
│  ElastiCache (Valkey 9.0, Multi-AZ, Synchronous Durability)     │
│  ─ Sorted sets: real-time ranked leaderboards                  │
│  ─ Hashes: durable ship profiles + lifetime stats              │
│  ─ Streams: event log (capped ~1000)                           │
│  ─ Strings: ephemeral session cache (TTL)                      │
│  ─ Sub-ms reads, atomic concurrent writes                      │
│  ─ Synchronous — persisted across 2+ AZs before responding     │
│  ─ 50K+ ops/sec from 100 concurrent Lambda workers             │
└─────────────────────────────────────────────────────────────────┘
```

ElastiCache with synchronous durability is the single data store. Every write is persisted across at least two Availability Zones before the client receives a response — designed for zero data loss. Profiles, rankings, events, and session caches all live in Valkey. Leaderboard resets clear the sorted sets; ship profiles persist in hashes. No separate database, no write-through sync, no eventual consistency between tiers.

## Load Test Results

Built-in load test harness with phased ramp-up (10→30→60→100 concurrent Lambda workers):

```
Phase 0:  10 workers |    75,000 ops |  5,000 ops/s | p50=  7.0ms | p99=  72.8ms
Phase 1:  30 workers |   225,000 ops | 15,000 ops/s | p50=  6.2ms | p99=  72.9ms
Phase 2:  60 workers |   450,000 ops | 30,000 ops/s | p50=  7.6ms | p99=  95.3ms
Phase 3: 100 workers |   750,000 ops | 50,000 ops/s | p50= 16.3ms | p99= 141.6ms
```

**1.5 million operations** across 200 workers. p50 stays under 8ms through 60 concurrent writers. Linear throughput scaling with no lock contention — this is what a lock-free sorted set buys you.

The p99 tail (~100-140ms) reflects Lambda execution overhead (cold starts, GC pauses), not ElastiCache latency. The Valkey operations themselves complete in 1-4ms; the measurement includes the full pipeline round-trip from Lambda through VPC networking.

## Running It

### Prerequisites
- AWS account with CDK bootstrapped in your target region
- Node.js 22+
- AWS credentials configured (environment variables or `~/.aws/credentials`)

### Deploy

```bash
# Clone
git clone https://github.com/rickrams/galactic-mining-league.git
cd galactic-mining-league

# Install dependencies (root CDK + Lambda + frontend)
npm install
cd lambda && npm install && cd ..
cd frontend && npm install && npm run build && cd ..

# Bootstrap CDK if not already done in your region
npx cdk bootstrap aws://<ACCOUNT_ID>/us-west-2

# Deploy (takes ~10 minutes on first deploy — creates VPC, ElastiCache cluster, Lambda, etc.)
export AWS_REGION=us-west-2
npx cdk deploy
```

Outputs:
```
GalacticMiningLeagueStack.ApiUrl = https://xxxxxxxxxx.execute-api.us-west-2.amazonaws.com
GalacticMiningLeagueStack.FrontendUrl = https://dxxxxxxxxxx.cloudfront.net
```

Open the `FrontendUrl` in a browser — you're ready to go. The first simulation will auto-generate ship profiles if none exist.

### Run a Simulation

```bash
# Seed starter profiles (or just launch — profiles auto-generate if needed)
curl -X POST $API_URL/ships/seed

# Launch 500 ships across 10 workers for 30 seconds
curl -X POST $API_URL/simulation/start \
  -H 'Content-Type: application/json' \
  -d '{"shipCount": 500, "duration": 30, "chunkSize": 50}'
```

The simulation auto-generates profiles in Valkey if fewer exist than requested — no manual setup needed for any fleet size.

### Run a Load Test

```bash
curl -X POST $API_URL/loadtest/start \
  -H 'Content-Type: application/json' \
  -d '{
    "phases": [
      {"duration": 20, "writers": 10, "shipsPerWriter": 50},
      {"duration": 20, "writers": 50, "shipsPerWriter": 50},
      {"duration": 20, "writers": 100, "shipsPerWriter": 50}
    ],
    "tickInterval": 200
  }'

# Check results (after estimated duration)
curl $API_URL/loadtest/<test-id>
```

Each worker reports latency percentiles (p50/p95/p99/max), ops completed, and errors. Results aggregate across all workers for a full picture of ElastiCache behavior under increasing concurrency.

### Tear Down

```bash
npx cdk destroy
```

## Tech Stack

| Component | Technology |
|---|---|
| Data store | Amazon ElastiCache (Valkey 9.0, r7g.large, Multi-AZ, Synchronous Durability) |
| Valkey client | [@valkey/valkey-glide](https://github.com/valkey-io/valkey-glide) (Rust core, Node.js bindings) |
| Compute | Lambda (Node.js 22.x) — API + fan-out workers |
| API | API Gateway HTTP API |
| Frontend | React + TypeScript |
| CDN | CloudFront + S3 |
| IaC | AWS CDK (TypeScript) |
| Networking | Fully private VPC — no NAT gateway, Lambda PrivateLink |

## What Makes This Different from a Toy Demo

- **Fan-out workers**: up to 200 concurrent Lambda writers hitting the same sorted sets — simulates real multi-tenant write contention
- **Single durable store**: ElastiCache with durability replaces both the cache layer and the database — one service, one bill, one data model
- **Atomic counter updates**: `HINCRBY` for lifetime stats directly in hashes — no read-modify-write, no separate counter table
- **Event stream**: workers emit lifecycle events to a capped Valkey Stream — frontend consumes incrementally via XRANGE, showing real-time simulation activity
- **Session caching**: profile data cached in Valkey with TTL for worker fan-out — eliminates Lambda payload limits and redundant scans
- **Load test harness**: phased ramp-up with per-worker latency percentiles — actually measures ElastiCache performance characteristics
- **Pagination + filtering**: handles 10,000+ member sorted sets with offset/limit pagination, ship class filtering, and score thresholds — all combinable
- **Time windows**: daily/weekly/alltime boards stored as independent sorted sets with historical date browsing
- **Scoring modes**: demonstrates both `ZINCRBY` (cumulative) and `ZADD GT` (best score) — two fundamental leaderboard patterns in one toggle
- **Cost-optimized networking**: VPC endpoints for Lambda invocation (PrivateLink), zero NAT gateway cost
