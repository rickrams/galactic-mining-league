# Development Journal — Galactic Mining League

A session-by-session account of how this app was built, the decisions made along the way, and what we learned about ElastiCache Serverless (Valkey) in the process.

## Starting Point

**Goal**: Build a sample leaderboard application using ElastiCache Serverless with the Valkey engine, eventually hosted on GitHub as a reference/demo.

**Initial decisions made through discussion**:
- Web UI with backend (not just a CLI or API demo)
- TypeScript end-to-end (CDK + Lambda + React share one language)
- Simulated fleet of workers generating scores — more interesting than manual data entry
- Theme: "Galactic Mining League" — mining ships competing to haul ore from asteroids

## Phase 1: Core Leaderboard (ioredis)

Built the first version with:
- CDK stack: VPC, ElastiCache Valkey Serverless, Lambda, API Gateway, S3/CloudFront
- Single sorted set (`ZINCRBY` for scoring, `ZREVRANGE` for reads)
- 20 hardcoded ships with a worker Lambda simulating score updates every 500ms
- React frontend with space theme, auto-polling leaderboard

**First client choice was ioredis** — out of habit. It's the most common Node.js Redis client with the largest ecosystem.

## Phase 2: Switch to Valkey GLIDE

User asked to use the GLIDE client instead. This revealed several API differences:
- `zrangeWithScores` returns `{element, score}[]` (not `{key, value}[]` as initially assumed)
- `hgetall` returns `{field, value}[]` in direct calls but `{key, value}[]` in batch pipelines — an inconsistency we had to handle with `f.field || f.key`
- `Batch(false)` for non-atomic pipelining instead of ioredis's `.pipeline()`
- `ConditionalChange.ONLY_IF_DOES_NOT_EXIST` enum instead of string `"NX"`
- ElastiCache Serverless uses cluster-mode routing internally, so multi-key `DEL` throws `CrossSlot` — had to delete keys one at a time

**Tradeoff discussion**: GLIDE is the right long-term bet for Valkey (official client, Rust core, will get Valkey-specific features first) but has documentation gaps and surprising return types today. ioredis would have been less friction but sends the wrong signal for a Valkey showcase.

## Phase 3: Feature Expansion (redis-rank inspired)

Expanded with five features inspired by the redis-rank library:

1. **Time-windowed leaderboards** — separate sorted set per window (daily/weekly/alltime). Each write fans out to all three keys. Added date/week query params and a `/leaderboard/windows` endpoint that scans for all available keys.

2. **ZADD GT "best score" mode** — toggle between `ZINCRBY` (cumulative) and `ZADD GT` (only-if-higher). Demonstrates two fundamental leaderboard patterns.

3. **Score threshold filter** — `ZCOUNT` for count + `ZRANGEBYSCORE` for entries. Hit a GLIDE gotcha: with `reverse: true`, start/end bounds must be swapped (high-to-low).

4. **Top-N cap** — `ZREMRANGEBYRANK` after every tick to enforce a maximum board size.

5. **ZCARD stats badges** — live ship counts per window displayed in the UI.

## Phase 4: DynamoDB Profile Store

Added a durable identity layer to make it closer to a real system:
- DynamoDB table for ship profiles (survives leaderboard resets)
- Profiles store: name, pilot, class, createdAt, lastActiveAt, totalSimulations, lifetimeOreHauled
- Worker loads profiles from DynamoDB, updates lifetime stats after simulation
- API enriches leaderboard from Valkey hash cache (fast path), DynamoDB as source of truth

This established the **two-tier storage** pattern: DynamoDB for durable identity, Valkey for hot-path ranked operations.

## Phase 5: Scale Up (Fan-Out Architecture)

User wanted to test with thousands of profiles and concurrent workers:

1. **Bulk profile generation** — `POST /ships/generate` creates 100–5000 synthetic profiles with combinatorial names
2. **Worker redesign** — instead of sampling from a hardcoded registry, workers receive a pre-sliced chunk of ships in their event payload
3. **API fan-out** — `startSimulation` scans DynamoDB, slices profiles into chunks, invokes N worker Lambdas in parallel
4. **Auto-generation** — if requested fleet size exceeds available profiles, API generates the shortfall automatically

Tested with 2000 ships across 40 concurrent workers. Found and fixed a bug where leaderboard entries showed "Unknown" names — the batch `HGETALL` in GLIDE returned `{key, value}[]` not `{field, value}[]`, and our `hashToObj` helper only handled one shape.

## Phase 6: Pagination + UI Controls

- Added `offset` and `limit` params to the leaderboard API
- Response envelope: `{entries, pagination: {offset, limit, count, total, hasMore}}`
- Frontend: Prev/Next buttons, page counter
- Fleet size selector expanded: 10, 50, 100, 500, 1K, 2K ships
- Worker chunk size control added to UI

## Phase 7: Load Test Harness

User wanted to characterize ElastiCache Serverless performance:

1. **DynamoDB table** for test metadata + per-worker results
2. **Phased ramp-up** — workers receive `startDelay` to create a gradual concurrency curve
3. **Per-tick latency tracking** — `process.hrtime.bigint()` around each batch exec
4. **Percentile computation** — p50/p95/p99/max aggregated across all workers
5. **Results endpoint** — aggregates worker reports, computes overall stats

**Load test results** (500 concurrent workers):
- p50 stays at 2.5–3.1ms from 100→500 concurrent writers
- Linear throughput scaling to 50,000 ops/sec
- 1.8M total ops, zero errors
- Hit Lambda concurrency ceiling (1000) before any ElastiCache degradation

## Phase 8: Code Cleanup

Honest audit revealed:
- Duplicated word lists (name generation arrays copied in two functions) → extracted to module-level `NAME_PARTS` + `generateProfile()` helper
- Ship ID collision risk (sequential numbering) → replaced with timestamp+random IDs (`ship-mpoig1nqes5gmw`)
- Dead `shipById` fallback map → removed entirely, metadata comes from Valkey hashes only
- `SHIP_REGISTRY` renamed to `SEED_FLEET` to clarify it's only for the initial seed endpoint

## Phase 9: VPC Optimization (No NAT)

Discussion about the architecture diagram revealed:
- DynamoDB traffic was going through the NAT gateway unnecessarily → added VPC Gateway Endpoint (free)
- Lambda invoke was also going through NAT → added VPC Interface Endpoint (PrivateLink)
- With both endpoints in place, NAT gateway serves no purpose → removed it entirely
- Final VPC: isolated subnets only, zero internet egress, all traffic on AWS backbone
- Saves ~$32/month + $0.045/GB data processing

## Phase 10: Write-Through Cache (Lifetime Stats)

User wanted lifetime stats (totalSimulations, lifetimeOreHauled) visible in the leaderboard UI:
- Worker uses DynamoDB `UpdateItem` with `ReturnValues: ALL_NEW`
- Writes the returned values back to Valkey hash (`HSET`)
- Leaderboard reads pick up lifetime stats for free in the existing `HGETALL` batch
- No additional DynamoDB calls on the read path

## Phase 11: Valkey Streams (Event Feed)

User asked about pub/sub for real-time updates. Discussion of tradeoffs:
- Pub/Sub requires long-lived subscribers — Lambda can't hold connections
- WebSocket API would add significant infrastructure
- **Streams are the right fit**: persist events, support replay, allow incremental polling

Implementation:
- Workers `XADD galactic:events` on sim_start, tick, sim_complete (capped at ~1000 entries)
- API endpoint `GET /events?since={id}` uses `XRANGE` with exclusive start boundary
- Frontend `EventFeed` component polls every 1s during simulation, tracks lastId
- Shows only when simulation is running (not cluttering the idle view)

## Phase 12: Session Caching (SET + EX)

Workers were receiving full profile objects in their Lambda invoke payload (~50KB per worker). At 2000 profiles this approaches the 256KB async payload limit.

Solution: ephemeral session cache in Valkey:
- API stores full profile list: `SET session:{id} <JSON> EX {duration+300}`
- Workers receive only `{sessionKey, startIndex, shipCount}` (~200 bytes)
- Workers `GET` the session key and slice their chunk
- Key auto-expires after simulation + 5 minute buffer

This demonstrates Valkey as a coordination-free shared data store — one writer, N readers, automatic cleanup.

## What We Ended Up Demonstrating

| Valkey Data Type | Pattern | Why It Matters |
|---|---|---|
| Sorted Set | Ranked leaderboard | O(log N) rank lookups, atomic updates, bounded size |
| Hash | Write-through metadata cache | Avoid DynamoDB on hot read path |
| Stream | Append-only event log | Incremental consumption, automatic trimming, replay |
| String (SET EX) | Ephemeral session cache | Coordination-free worker fan-out, TTL cleanup |
| SCAN | Key discovery | Safe enumeration without blocking |

## Running Cost Estimate (Idle)

| Resource | Monthly Cost |
|---|---|
| ElastiCache Serverless (idle) | ~$0 (pay per ECPU, baseline is minimal) |
| DynamoDB (on-demand, idle) | ~$0 (pay per request) |
| VPC Interface Endpoint (Lambda) | ~$14.40 (2 AZs × $7.20/AZ/month) |
| CloudFront + S3 | ~$1 (minimal traffic) |
| **Total idle** | **~$16/month** |

During active load testing (e.g., 500 workers for 60s), the costs are dominated by Lambda compute and ElastiCache ECPUs — typically a few cents per test run.
