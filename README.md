# Galactic Mining League

A sample leaderboard application built on **Amazon ElastiCache Serverless** (Valkey engine) demonstrating why sorted sets are the ideal primitive for real-time rankings — and what you'd have to build yourself without them.

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

### Time-Windowed Boards

Separate sorted set per time window — no schema changes, no migrations:

```
galactic:leaderboard:alltime            ← cumulative
galactic:leaderboard:daily:2026-05-27   ← resets each day
galactic:leaderboard:weekly:2026-W22    ← resets each week
```

Each write fans out to all three keys. Each key is independently queryable with its own pagination, filtering, and rank lookups. In SQL you'd need partitioned tables or materialized views. In DynamoDB you'd need separate GSIs per window.

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

After every scoring tick, prune everyone below rank 500. The sorted set never grows unbounded. In SQL this is a `DELETE FROM ... WHERE rank > 500` subquery that touches every row. In DynamoDB you'd need to scan, identify, and batch-delete — a multi-step workflow for what Valkey does in one atomic command.

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

### Hash as a Metadata Cache Layer

```
HSET ship:abc123 shipName "ISS Ironclad" pilotName "Zara Voss" shipClass "Excavator"
                 totalSimulations "8" lifetimeOreHauled "175970"
```

Ship identity and lifetime stats stored alongside the leaderboard in Valkey hashes. When rendering a leaderboard page, batch-fetch metadata for all 50 entries in one pipeline — no DynamoDB round-trips on the hot read path.

The data flow for lifetime stats:
1. Worker completes simulation
2. DynamoDB `UpdateItem` with `ADD totalSimulations :1, lifetimeOreHauled :ore` (durable increment)
3. `ReturnValues: ALL_NEW` gives back the updated totals
4. Worker writes updated values to Valkey hash (`HSET ship:{id} totalSimulations "8" lifetimeOreHauled "175970"`)
5. Next leaderboard read picks them up for free in the existing `HGETALL` batch

This is the **write-through cache** pattern: DynamoDB is the source of truth for lifetime data, but Valkey serves it on the hot read path. The leaderboard page never calls DynamoDB — it gets everything (name, class, score, rank, lifetime stats) from Valkey in two pipelined calls: `ZRANGEWITHSCORES` + batch `HGETALL`.

### Streams as an Event Log

```
XADD galactic:events * type sim_start workerId 3 ships 50 duration 30
XADD galactic:events * type tick workerId 3 tick 12 opsThisTick 150
XADD galactic:events * type sim_complete workerId 3 totalUpdates 9000 p50 3.2
```

Workers emit events to a capped Valkey Stream on every lifecycle event (start, tick, complete). The stream auto-trims to ~1000 entries via `MAXLEN ~1000` — approximate trimming is more efficient than exact because Valkey can delete whole radix tree nodes.

The frontend polls incrementally:
```
GET /events?since=1779923235915-0&limit=20
```

Returns only events *after* the given stream ID — no re-reading old data. This is the "consumer polling" pattern: each client tracks its last-read position and fetches forward. In a production system this would be a WebSocket with `XREAD BLOCK`, but the pattern is the same.

Why Streams over Pub/Sub here: Pub/Sub is fire-and-forget — if the subscriber isn't connected when the message is published, it's lost. Streams persist events with automatic IDs, support replay from any point, and allow multiple independent consumers to read at their own pace.

### Ephemeral Session Cache (SET + EX)

```
SET session:sim-abc123 <JSON array of 2000 profiles> EX 360
```

When launching a simulation, the API stores the full profile list in Valkey with a TTL. Workers receive only `{sessionKey, startIndex, shipCount}` in their invoke payload (~200 bytes) and `GET` the session key to retrieve their slice. The key auto-expires after the simulation completes.

This solves:
- **Lambda payload limit** (256KB for async invoke) — 2000 profiles × ~200 bytes each = 400KB, won't fit in a single invoke
- **Redundant DynamoDB scans** — one scan, one `SET`, N `GET`s
- **Coordination-free sharing** — workers independently read the same key, slice their own chunk

## Architecture: Two-Tier Storage

> Full architecture diagrams, sequence flows, and design decisions: [ARCHITECTURE.md](ARCHITECTURE.md)

```
┌─────────────────────────────────────────────────────────────┐
│  DynamoDB (GalacticMiningProfiles)                          │
│  ─ Durable identity store (survives leaderboard resets)    │
│  ─ Lifetime stats: totalSimulations, lifetimeOreHauled     │
│  ─ Profile metadata: name, pilot, class, timestamps        │
│  ─ Source of truth — Valkey is rebuilt from this           │
└──────────────────────────┬──────────────────────────────────┘
                           │ Load profiles at sim start
                           │ Write-through after sim completes
┌──────────────────────────▼──────────────────────────────────┐
│  ElastiCache Serverless (galactic-mining, Valkey engine)    │
│  ─ Sorted sets: real-time ranked leaderboards              │
│  ─ Hashes: metadata + lifetime stats cache (hot path)      │
│  ─ Sub-ms reads, atomic concurrent writes                  │
│  ─ 50K+ ops/sec from 100 concurrent Lambda workers         │
│  ─ Ephemeral rankings — profiles persist through resets    │
└─────────────────────────────────────────────────────────────┘
```

DynamoDB is the system of record. ElastiCache Serverless is the performance layer. Leaderboard resets clear the sorted sets but profiles persist in DynamoDB. On the next simulation, profiles are loaded from DynamoDB, registered in Valkey, and lifetime stats are synced back after completion. This mirrors how production systems work: a durable store for user identity, a cache/compute layer for hot-path operations that need sub-millisecond ranked access.

## Load Test Results

Built-in load test harness with phased ramp-up (10→30→60→100 concurrent Lambda workers):

```
Phase 0:  10 workers |    75,000 ops |  5,000 ops/s | p50=  7.0ms | p99=  72.8ms
Phase 1:  30 workers |   225,000 ops | 15,000 ops/s | p50=  6.2ms | p99=  72.9ms
Phase 2:  60 workers |   450,000 ops | 30,000 ops/s | p50=  7.6ms | p99=  95.3ms
Phase 3: 100 workers |   750,000 ops | 50,000 ops/s | p50= 16.3ms | p99= 141.6ms
```

**1.5 million operations** across 200 workers. p50 stays under 8ms through 60 concurrent writers. Linear throughput scaling with no lock contention — this is what a lock-free sorted set buys you.

The p99 tail (~100-140ms) reflects Lambda execution overhead (cold starts, GC pauses), not ElastiCache Serverless latency. The Valkey operations themselves complete in 1-4ms; the measurement includes the full pipeline round-trip from Lambda through VPC networking.

## Running It

### Prerequisites
- AWS account with CDK bootstrapped (`npx cdk bootstrap`)
- Node.js 22+
- AWS credentials configured

### Deploy

```bash
cd frontend && npm install && npm run build && cd ..
npm install
npx cdk deploy
```

Outputs the API URL and CloudFront frontend URL.

### Run a Simulation

```bash
# Seed starter profiles (or just launch — profiles auto-generate if needed)
curl -X POST $API_URL/ships/seed

# Launch 500 ships across 10 workers for 30 seconds
curl -X POST $API_URL/simulation/start \
  -H 'Content-Type: application/json' \
  -d '{"shipCount": 500, "duration": 30, "chunkSize": 50}'
```

The simulation auto-generates profiles in DynamoDB if fewer exist than requested — no manual setup needed for any fleet size.

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

Each worker reports latency percentiles (p50/p95/p99/max), ops completed, and errors. Results aggregate across all workers for a full picture of ElastiCache Serverless behavior under increasing concurrency.

### Tear Down

```bash
npx cdk destroy
```

## Tech Stack

| Component | Technology |
|---|---|
| Leaderboard engine | Amazon ElastiCache Serverless (Valkey engine) |
| Valkey client | [@valkey/valkey-glide](https://github.com/valkey-io/valkey-glide) (Rust core, Node.js bindings) |
| Profile store | DynamoDB (on-demand) |
| Compute | Lambda (Node.js 22.x) — API + fan-out workers |
| API | API Gateway HTTP API |
| Frontend | React + TypeScript |
| CDN | CloudFront + S3 |
| IaC | AWS CDK (TypeScript) |
| Networking | Fully private VPC — no NAT gateway, DynamoDB Gateway Endpoint + Lambda PrivateLink |

## What Makes This Different from a Toy Demo

- **Fan-out workers**: up to 200 concurrent Lambda writers hitting the same sorted sets — simulates real multi-tenant write contention
- **Two-tier storage**: DynamoDB for durable profiles + ElastiCache for hot rankings — the production pattern, not a shortcut
- **Write-through cache**: lifetime stats flow DynamoDB → Valkey hash on every sim completion, so reads never hit DynamoDB
- **Event stream**: workers emit lifecycle events to a capped Valkey Stream — frontend consumes incrementally via XRANGE, showing real-time simulation activity
- **Session caching**: profile data cached in Valkey with TTL for worker fan-out — eliminates Lambda payload limits and redundant DynamoDB scans
- **Load test harness**: phased ramp-up with per-worker latency percentiles — actually measures ElastiCache Serverless performance characteristics
- **Pagination + filtering**: handles 10,000+ member sorted sets with offset/limit pagination, ship class filtering, and score thresholds — all combinable
- **Time windows**: daily/weekly/alltime boards stored as independent sorted sets with historical date browsing
- **Scoring modes**: demonstrates both `ZINCRBY` (cumulative) and `ZADD GT` (best score) — two fundamental leaderboard patterns in one toggle
- **Cost-optimized networking**: VPC endpoints for all AWS service calls (DynamoDB Gateway Endpoint + Lambda Interface Endpoint), zero NAT gateway cost
