# Galactic Mining League

A sample leaderboard application built on **ElastiCache for Valkey (Serverless)** demonstrating why sorted sets are the ideal primitive for real-time rankings — and what you'd have to build yourself without them.

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
galactic:leaderboard:alltime        ← cumulative
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

### Hash Metadata Cache

```
HSET ship:abc123 shipName "ISS Ironclad" pilotName "Zara Voss" shipClass "Excavator"
```

Ship identity stored alongside the leaderboard in Valkey. When rendering a leaderboard page, batch-fetch metadata for all 50 entries in one pipeline — no DynamoDB round-trips on the hot read path.

## Architecture: Two-Tier Storage

```
┌─────────────────────────────────────────────────────────────┐
│  DynamoDB (GalacticMiningProfiles)                          │
│  ─ Durable identity store                                   │
│  ─ Survives leaderboard resets                             │
│  ─ Tracks lifetime stats (totalSimulations, lifetimeOre)   │
│  ─ Source of truth for profile data                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ Load at sim start,
                           │ update post-sim
┌──────────────────────────▼──────────────────────────────────┐
│  Valkey Serverless (galactic-mining)                         │
│  ─ Real-time leaderboard (sorted sets)                     │
│  ─ Ship metadata cache (hashes)                            │
│  ─ Sub-ms reads, atomic writes                             │
│  ─ 50K+ ops/sec from concurrent writers                    │
│  ─ Ephemeral — rebuilt from DynamoDB on reset              │
└─────────────────────────────────────────────────────────────┘
```

DynamoDB is the system of record. Valkey is the performance layer. Leaderboard resets clear Valkey but profiles persist. This mirrors how production systems work: a durable store for user identity, a cache/compute layer for hot-path operations.

## Load Test Results

Built-in load test harness with phased ramp-up (5→20→50→100 concurrent Lambda workers):

```
Phase 0:  10 workers |    75,000 ops |  5,000 ops/s | p50=  7.0ms | p99=  72.8ms
Phase 1:  30 workers |   225,000 ops | 15,000 ops/s | p50=  6.2ms | p99=  72.9ms
Phase 2:  60 workers |   450,000 ops | 30,000 ops/s | p50=  7.6ms | p99=  95.3ms
Phase 3: 100 workers |   750,000 ops | 50,000 ops/s | p50= 16.3ms | p99= 141.6ms
```

**1.5 million operations** across 200 workers. p50 stays under 8ms through 60 concurrent writers. Linear throughput scaling with no lock contention — this is what a lock-free sorted set buys you.

## Running It

### Prerequisites
- AWS account with CDK bootstrapped
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
# Seed profiles
curl -X POST $API_URL/ships/seed

# Launch 500 ships across 10 workers for 30 seconds
curl -X POST $API_URL/simulation/start \
  -H 'Content-Type: application/json' \
  -d '{"shipCount": 500, "duration": 30, "chunkSize": 50}'
```

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

### Tear Down

```bash
npx cdk destroy
```

## Tech Stack

| Component | Technology |
|---|---|
| Leaderboard engine | ElastiCache for Valkey (Serverless) |
| Valkey client | [@valkey/valkey-glide](https://github.com/valkey-io/valkey-glide) (Rust core, Node.js bindings) |
| Profile store | DynamoDB (on-demand) |
| Compute | Lambda (Node.js 22.x) — API + fan-out workers |
| API | API Gateway HTTP API |
| Frontend | React + TypeScript |
| CDN | CloudFront + S3 |
| IaC | AWS CDK (TypeScript) |
| Networking | Fully private VPC — no NAT gateway, DynamoDB Gateway Endpoint + Lambda PrivateLink |

## What Makes This Different from a Toy Demo

- **Fan-out workers**: simulates real concurrent writer load, not a single-threaded loop
- **Two-tier storage**: DynamoDB for durable profiles + Valkey for hot rankings (production pattern)
- **Load test harness**: phased ramp with per-worker latency percentiles — actually measures performance
- **Pagination + filtering**: handles 2,000+ member sorted sets with paginated reads and server-side class filtering
- **Time windows**: daily/weekly/alltime boards with historical date selection
- **Scoring modes**: demonstrates both `ZINCRBY` (cumulative) and `ZADD GT` (best score) patterns
- **Cost-optimized networking**: VPC endpoints for all AWS service calls, zero NAT gateway cost
