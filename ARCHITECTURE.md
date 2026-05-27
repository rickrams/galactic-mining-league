# Galactic Mining League — Architecture

## System Diagram

```mermaid
graph TB
    subgraph "Client"
        Browser["Browser (React SPA)<br/>Polling, Pagination, Filters"]
    end

    subgraph "AWS Cloud — us-west-2"
        subgraph "Edge"
            CF["CloudFront Distribution"]
            S3["S3 Bucket<br/>(static assets + config.json)"]
        end

        APIGW["API Gateway HTTP API<br/>(CORS enabled)"]
        DDB["DynamoDB<br/>GalacticMiningProfiles +<br/>GalacticMiningLoadTests"]

        subgraph "VPC (10.0.0.0/16) — Fully Private, No NAT"
            subgraph "Isolated Subnets (2 AZs)"
                API_LAMBDA["API Lambda<br/>galactic-mining-api<br/>(Node.js 22.x, 60s timeout)"]
                WORKER_LAMBDA["Worker Lambda ×N<br/>galactic-mining-worker<br/>(Node.js 22.x, 5min timeout)<br/>Fan-out: up to 200 concurrent"]
                VALKEY["ElastiCache Serverless<br/>(Valkey engine)<br/>galactic-mining<br/>(TLS, port 6379)"]
                VPCE_DDB["VPC Gateway Endpoint<br/>(DynamoDB)"]
                VPCE_LAMBDA["VPC Interface Endpoint<br/>(Lambda — PrivateLink)"]
            end
        end
    end

    Browser -->|"HTTPS"| CF
    CF -->|"static files"| S3
    Browser -->|"API calls"| APIGW
    APIGW --> API_LAMBDA
    API_LAMBDA -->|"TLS :6379"| VALKEY
    WORKER_LAMBDA -->|"TLS :6379<br/>Batch pipeline"| VALKEY
    API_LAMBDA -->|"private"| VPCE_DDB
    WORKER_LAMBDA -->|"private"| VPCE_DDB
    VPCE_DDB -->|"AWS backbone"| DDB
    API_LAMBDA -->|"Invoke ×N<br/>(fan-out)"| VPCE_LAMBDA
    VPCE_LAMBDA -->|"PrivateLink"| WORKER_LAMBDA
```

All traffic stays on AWS private networking. No NAT gateway, no internet egress. DynamoDB access via Gateway Endpoint (free). Lambda invocation via Interface Endpoint (PrivateLink).

## Data Flow: Write-Through Cache Pattern

```mermaid
graph LR
    subgraph "DynamoDB — Durable Store"
        DDB_TABLE["GalacticMiningProfiles<br/>(source of truth)"]
        DDB_ITEM["shipId: ship-01234<br/>shipName: ISS Quantum Bringer<br/>pilotName: Kael Dryden<br/>shipClass: Excavator<br/>createdAt: 2026-05-27T...<br/>lastActiveAt: 2026-05-27T...<br/>totalSimulations: 8<br/>lifetimeOreHauled: 175,970"]
    end

    subgraph "ElastiCache Serverless — Hot Path"
        ZSETS["Sorted Sets<br/>(leaderboard rankings)"]
        HASHES["Hashes<br/>(metadata + lifetime stats)"]
    end

    DDB_TABLE -->|"1. Load profiles<br/>at sim start"| ZSETS
    DDB_TABLE -->|"2. UpdateItem<br/>ReturnValues: ALL_NEW"| DDB_ITEM
    DDB_ITEM -->|"3. Write-through<br/>HSET lifetime stats"| HASHES
    ZSETS -->|"4. Leaderboard reads<br/>enrich from hash"| HASHES
```

The write-through flow:
1. Worker loads profiles from DynamoDB, registers them in sorted sets
2. After simulation, worker increments `totalSimulations` and `lifetimeOreHauled` in DynamoDB
3. DynamoDB returns the new values (`ReturnValues: ALL_NEW`)
4. Worker writes updated stats to Valkey hash — leaderboard reads pick them up for free

## Data Model (Valkey)

```mermaid
graph LR
    subgraph "Sorted Sets (ZSET) — Leaderboards"
        A["galactic:leaderboard:alltime<br/>10,000+ members"]
        B["galactic:leaderboard:daily:YYYY-MM-DD"]
        C["galactic:leaderboard:weekly:YYYY-Wnn"]
    end

    subgraph "Hashes — Metadata + Lifetime Cache"
        H["ship:{shipId}<br/>{shipName, pilotName, shipClass,<br/>totalSimulations, lifetimeOreHauled}"]
    end

    subgraph "Streams — Event Log"
        S["galactic:events<br/>(capped ~1000 entries)<br/>{type, workerId, tick, opsThisTick, ...}"]
    end

    subgraph "Strings — Session Cache"
        K["session:{simId}<br/>JSON array of profiles<br/>(TTL: duration + 5min)"]
    end

    A -->|"HGETALL batch<br/>on read"| H
    B -->|"HGETALL batch"| H
    C -->|"HGETALL batch"| H
```

## API Routes

| Method | Path | Backend | Feature |
|--------|------|---------|---------|
| `GET` | `/leaderboard?window=&date=&week=&offset=&limit=&shipClass=` | `ZRANGEWITHSCORES`, `ZCARD`, `HGETALL` batch | Paginated, filterable leaderboard |
| `GET` | `/leaderboard/windows` | `SCAN` pattern match | Discover all available date/week keys |
| `GET` | `/leaderboard/stats` | `ZCARD` ×3 | Ship counts per window |
| `GET` | `/leaderboard/above/{threshold}?window=&shipClass=` | `ZRANGEWITHSCORES` byScore + `HGETALL` batch | Score threshold + class filter |
| `GET` | `/ships` | DynamoDB `Scan` | List all profiles |
| `GET` | `/ships/{id}` | DynamoDB `GetItem` + `ZREVRANK`, `ZSCORE` | Profile with live rank |
| `GET` | `/ships/{id}/rank?window=` | `ZREVRANK`, `ZSCORE`, `HGETALL` | Rank in specific window |
| `POST` | `/ships` | DynamoDB `PutItem` + `HSET` | Create profile |
| `POST` | `/ships/seed` | DynamoDB `BatchWrite` + `HSET` batch | Seed 20 starter profiles |
| `POST` | `/ships/generate` | DynamoDB `BatchWrite` ×N | Generate 100–5000 synthetic profiles |
| `POST` | `/ships/{id}/score` | `ZINCRBY` or `ZADD GT` | Manual score update |
| `POST` | `/simulation/start` | DynamoDB `Scan` + Lambda `Invoke` ×N | Fan-out fleet simulation |
| `POST` | `/leaderboard/topn` | `ZREMRANGEBYRANK`, `ZCARD` | Prune to top-N |
| `GET` | `/events?since=&limit=` | `XRANGE`, `XLEN` | Incremental event stream consumption |
| `POST` | `/loadtest/start` | DynamoDB + Lambda `Invoke` ×N (phased) | Phased load test with ramp-up |
| `GET` | `/loadtest/{id}` | DynamoDB `Scan` + aggregate | Load test results with latency percentiles |
| `GET` | `/loadtests` | DynamoDB `Scan` | List all load tests |
| `DELETE` | `/leaderboard` | `DEL`, `SCAN` + `DEL` | Full leaderboard reset |

## Simulation Flow (Fan-Out Architecture)

```mermaid
sequenceDiagram
    participant UI as React UI
    participant API as API Lambda
    participant DDB as DynamoDB
    participant W1 as Worker #1
    participant W2 as Worker #2
    participant WN as Worker #N
    participant V as ElastiCache Serverless

    UI->>API: POST /simulation/start<br/>{shipCount:2000, duration:30, chunkSize:50}
    API->>DDB: Scan profiles (auto-generate if < 2000 exist)
    DDB-->>API: 2000 profiles

    par Fan-out (40 workers × 50 ships each)
        API->>W1: InvokeAsync {ships[0..49], duration:30}
        API->>W2: InvokeAsync {ships[50..99], duration:30}
        API->>WN: InvokeAsync {ships[1950..1999], duration:30}
    end

    API-->>UI: 202 {workerCount: 40, shipCount: 2000}

    par All workers run concurrently
        loop Every tick (200–500ms)
            W1->>V: Batch: ZINCRBY ×50 ships ×3 keys = 150 ops
            W2->>V: Batch: ZINCRBY ×50 ships ×3 keys = 150 ops
            WN->>V: Batch: ZINCRBY ×50 ships ×3 keys = 150 ops
        end
    end

    Note over W1,WN: ~360,000 total Valkey writes over 30s

    par Post-simulation: write-through cache update
        W1->>DDB: UpdateItem ×50 (ReturnValues: ALL_NEW)
        DDB-->>W1: Updated lifetime stats
        W1->>V: HSET ×50 (sync lifetime stats to hash)
        W2->>DDB: UpdateItem ×50
        DDB-->>W2: Updated lifetime stats
        W2->>V: HSET ×50
    end

    loop Every 2s (UI polling)
        UI->>API: GET /leaderboard?offset=0&limit=50
        API->>V: ZRANGEWITHSCORES + HGETALL batch
        V-->>API: entries with scores + metadata + lifetime stats
        API-->>UI: {entries, pagination: {total: 2000}}
    end
```

## Load Test Flow (Phased Ramp-Up)

```mermaid
sequenceDiagram
    participant API as API Lambda
    participant DDB as DynamoDB
    participant P1 as Phase 1 Workers (×10)
    participant P2 as Phase 2 Workers (×30)
    participant P3 as Phase 3 Workers (×100)
    participant V as ElastiCache Serverless

    API->>DDB: Write test metadata (testId, phases, status:running)
    
    par All phases launched simultaneously with staggered startDelay
        API->>P1: Invoke ×10 (startDelay: 0s)
        API->>P2: Invoke ×30 (startDelay: 20s)
        API->>P3: Invoke ×100 (startDelay: 40s)
    end

    Note over P1: Phase 1: 10 workers start immediately
    P1->>V: 5,000 ops/sec for 20s
    
    Note over P2: Phase 2: 30 workers start at t+20s
    P2->>V: 15,000 ops/sec for 20s

    Note over P3: Phase 3: 100 workers start at t+40s
    P3->>V: 50,000 ops/sec for 20s

    par Each worker reports results
        P1->>DDB: PutItem {latencyMs: {p50, p95, p99, max}, opsPerSecond, ...}
        P2->>DDB: PutItem {latencyMs: ...}
        P3->>DDB: PutItem {latencyMs: ...}
    end

    Note over API: GET /loadtest/{id} aggregates all worker results
```

## Valkey Features Demonstrated

| Valkey Feature | How It's Used | Scale Tested |
|---|---|---|
| **Sorted Sets (ZSET)** | Core leaderboard data structure — O(log N) rank lookups | 10,000+ members |
| **ZINCRBY** | Cumulative score mode (atomic increment) | 50,000 ops/sec sustained |
| **ZADD GT** | "Best score" mode — only replace if new > stored | Same throughput |
| **ZADD NX** | Initialize without overwriting existing scores | 10,000 per sim start |
| **ZRANGEWITHSCORES** | Paginated retrieval (offset/limit via index range) | Page through 10K entries |
| **ZRANGEBYSCORE** | Score threshold filter + class filter (over-fetch + filter) | Filter across full set |
| **ZREVRANK** | O(log N) individual rank lookup | Per-profile queries |
| **ZCOUNT** | Count members in score range | Threshold badge |
| **ZCARD** | Total member count per window | Stats cards |
| **ZREMRANGEBYRANK** | Top-N cap enforcement per tick | Prune to top 10–500 |
| **HSET / HGETALL** | Metadata + lifetime stats cache (write-through from DynamoDB) | Batch 50–200 per page |
| **XADD + MAXLEN** | Capped event stream — workers emit tick/start/complete events | ~1000 entries, auto-trimmed |
| **XRANGE** | Incremental stream reads — frontend polls with exclusive start ID | 20 events/poll, 1s interval |
| **XLEN** | Stream depth indicator in UI | Live count |
| **SET + EX** | Ephemeral session cache — profile data shared across workers via TTL key | 2000+ profiles, 5min TTL |
| **GET** | Workers read session cache to retrieve their ship slice | N concurrent readers, one key |
| **SCAN** | Safe key enumeration (reset, window discovery) | Pattern: `galactic:leaderboard:*` |
| **Pipelining (Batch)** | Bulk operations — one round-trip per tick per worker | 150 ops/batch × 100 workers |
| **TLS** | Encrypted transport (required by ElastiCache Serverless) | All connections |
| **Concurrent writers** | Up to 200 Lambda workers writing to same sorted sets | Lock-free, linear scaling to 50K ops/sec |

## Infrastructure (CDK)

```
galactic-mining-league/
├── bin/                      # CDK app entry point
├── lib/                      # CDK stack definition
│   └── galactic-mining-league-stack.ts
│       ├── VPC (2 AZ, isolated subnets, no NAT)
│       ├── VPC Endpoints (DynamoDB Gateway + Lambda PrivateLink)
│       ├── Security Groups (Lambda ↔ Valkey)
│       ├── ElastiCache Serverless (Valkey engine)
│       ├── DynamoDB Tables ×2 (Profiles + LoadTests, PAY_PER_REQUEST)
│       ├── Lambda: API (NodejsFunction, esbuild bundled)
│       ├── Lambda: Worker (NodejsFunction, esbuild bundled)
│       ├── API Gateway HTTP API (17 route paths)
│       ├── S3 + CloudFront (OAC, SPA routing)
│       └── BucketDeployment (frontend + config.json)
├── lambda/
│   ├── api/handler.js        # All API routes (GLIDE + DynamoDB)
│   ├── worker/handler.js     # Simulation engine (fan-out, latency tracking)
│   └── package.json          # @valkey/valkey-glide + @aws-sdk
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # Polling, pagination, filters, tabs
│   │   ├── api.ts            # API client (typed)
│   │   ├── types.ts          # TypeScript interfaces
│   │   └── components/
│   │       ├── Leaderboard.tsx       # Table with rank, bars, lifetime stats
│   │       └── SimulationControls.tsx # Fleet size, duration, mode, cap, chunk size
│   └── build/                # Production build → S3
├── ARCHITECTURE.md           # This file
└── cdk.out/                  # Synthesized CloudFormation
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| ElastiCache Serverless for leaderboard, DynamoDB for profiles | Sorted sets give O(log N) rank ops; DynamoDB gives durable identity that survives resets |
| Write-through cache pattern | Worker writes lifetime stats to both DynamoDB (durable) and Valkey hash (fast reads) — leaderboard page never hits DynamoDB |
| Fan-out workers (not single Lambda) | Simulates realistic concurrent writer load; tests ElastiCache Serverless lock-free sorted set under contention |
| Fully private VPC (no NAT) | DynamoDB Gateway Endpoint + Lambda PrivateLink = zero egress cost, all traffic on AWS backbone |
| Server-side class filter via over-fetch | No native secondary index in sorted sets; scan-and-filter with early-exit is fast enough at scale |
| Pagination via ZRANGEWITHSCORES offset | O(log N + M) — efficient for any page depth |
| Time-windowed keys (daily/weekly/alltime) | Separate sorted sets per window = independent lifecycle, no cross-contamination |
| `ZADD GT` vs `ZINCRBY` toggle | Demonstrates two common leaderboard patterns (cumulative vs. high-score) in one UI toggle |
| `ZREMRANGEBYRANK` per tick | Shows real-time pruning under write load |
| Streams over Pub/Sub for events | Streams persist (replay from any point), Pub/Sub doesn't — Lambda can't hold subscriptions, so polling XRANGE with `since` is the right pattern |
| Session cache with TTL (SET EX) | Avoids Lambda 256KB payload limit at scale; one Valkey write replaces N copies of profile data in invoke payloads |
| Phased load test with startDelay | Workers sleep before starting to create a realistic ramp-up curve, measuring where latency degrades |
| Per-worker latency percentiles via hrtime | Measures actual Valkey pipeline round-trip time (not Lambda overhead) for accurate characterization |
