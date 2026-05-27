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
        DDB["DynamoDB<br/>GalacticMiningProfiles<br/>(on-demand, shipId PK)"]

        subgraph "VPC (10.0.0.0/16)"
            subgraph "Private Subnets"
                API_LAMBDA["API Lambda<br/>galactic-mining-api<br/>(Node.js 22.x, 60s timeout)"]
                WORKER_LAMBDA["Worker Lambda ×N<br/>galactic-mining-worker<br/>(Node.js 22.x, 5min timeout)<br/>Fan-out: up to 100 concurrent"]
                VALKEY["ElastiCache Valkey Serverless<br/>galactic-mining<br/>(TLS, port 6379)"]
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

## Data Flow: Two-Tier Storage

```mermaid
graph LR
    subgraph "DynamoDB — Durable Identity Store"
        DDB_TABLE["GalacticMiningProfiles<br/>(survives resets)"]
        DDB_ITEM["shipId: ship-01234<br/>shipName: ISS Quantum Bringer<br/>pilotName: Kael Dryden<br/>shipClass: Excavator<br/>createdAt: 2026-05-27T...<br/>lastActiveAt: 2026-05-27T...<br/>totalSimulations: 5<br/>lifetimeOreHauled: 142,500"]
    end

    subgraph "Valkey — High-Performance Cache"
        ZSETS["Sorted Sets (leaderboards)<br/>O(log N) rank ops"]
        HASHES["Hashes (metadata cache)<br/>O(1) enrichment"]
    end

    DDB_TABLE -->|"Seed/Generate<br/>profiles"| DDB_ITEM
    DDB_ITEM -->|"Worker loads at<br/>sim start"| ZSETS
    DDB_ITEM -->|"Cached on write"| HASHES
    ZSETS -->|"Leaderboard reads"| HASHES
```

## Data Model (Valkey)

```mermaid
graph LR
    subgraph "Sorted Sets (ZSET) — Leaderboards"
        A["galactic:leaderboard:alltime<br/>2,000+ members"]
        B["galactic:leaderboard:daily:YYYY-MM-DD"]
        C["galactic:leaderboard:weekly:YYYY-Wnn"]
    end

    subgraph "Hashes — Ship Metadata Cache"
        H["ship:{shipId}<br/>{shipName, pilotName, shipClass}"]
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
| `GET` | `/leaderboard/above/{threshold}?window=` | `ZCOUNT`, `ZRANGEWITHSCORES` byScore | Score threshold filter |
| `GET` | `/ships` | DynamoDB `Scan` | List all profiles |
| `GET` | `/ships/{id}` | DynamoDB `GetItem` + `ZREVRANK`, `ZSCORE` | Profile with live rank |
| `GET` | `/ships/{id}/rank?window=` | `ZREVRANK`, `ZSCORE`, `HGETALL` | Rank in specific window |
| `POST` | `/ships` | DynamoDB `PutItem` + `HSET` | Create profile |
| `POST` | `/ships/seed` | DynamoDB `BatchWrite` + `HSET` batch | Seed 20 starter profiles |
| `POST` | `/ships/generate` | DynamoDB `BatchWrite` ×N | Generate 100–5000 synthetic profiles |
| `POST` | `/ships/{id}/score` | `ZINCRBY` or `ZADD GT` + `HSET` | Manual score update |
| `POST` | `/simulation/start` | DynamoDB `Scan` + Lambda `Invoke` ×N | Fan-out fleet simulation |
| `POST` | `/leaderboard/topn` | `ZREMRANGEBYRANK`, `ZCARD` | Prune to top-N |
| `DELETE` | `/leaderboard` | `DEL`, `SCAN` + `DEL` | Full leaderboard reset |

## Simulation Flow (Fan-Out Architecture)

```mermaid
sequenceDiagram
    participant UI as React UI
    participant API as API Lambda
    participant DDB as DynamoDB
    participant W1 as Worker Lambda #1
    participant W2 as Worker Lambda #2
    participant WN as Worker Lambda #N
    participant V as Valkey Serverless

    UI->>API: POST /simulation/start<br/>{shipCount:2000, duration:30, chunkSize:50}
    API->>DDB: Scan all profiles
    DDB-->>API: 2000 profiles
    
    par Fan-out (40 workers × 50 ships each)
        API->>W1: InvokeAsync {ships[0..49], duration:30}
        API->>W2: InvokeAsync {ships[50..99], duration:30}
        API->>WN: InvokeAsync {ships[1950..1999], duration:30}
    end
    
    API-->>UI: 202 {workerCount: 40, shipCount: 2000}

    par All workers run concurrently for 30s
        loop Every 500ms
            W1->>V: Batch: ZINCRBY ×50 ships ×3 keys = 150 ops
            W2->>V: Batch: ZINCRBY ×50 ships ×3 keys = 150 ops
            WN->>V: Batch: ZINCRBY ×50 ships ×3 keys = 150 ops
        end
    end

    Note over W1,WN: ~360,000 total Valkey writes over 30s

    par Post-simulation DynamoDB updates
        W1->>DDB: UpdateItem ×50 (lifetimeOreHauled, totalSimulations)
        W2->>DDB: UpdateItem ×50
        WN->>DDB: UpdateItem ×50
    end

    loop Every 2s (UI polling)
        UI->>API: GET /leaderboard?offset=0&limit=50
        API->>V: ZRANGEWITHSCORES + HGETALL batch
        V-->>API: top 50 entries
        API-->>UI: {entries, pagination: {total: 2000}}
    end
```

## Valkey Features Demonstrated

| Valkey Feature | How It's Used | Scale Tested |
|---|---|---|
| **Sorted Sets (ZSET)** | Core leaderboard data structure — O(log N) rank lookups | 2,000+ members |
| **ZINCRBY** | Cumulative score mode (atomic increment) | 6,000 ops/tick × 60 ticks |
| **ZADD GT** | "Best score" mode — only replace if new > stored | Same throughput |
| **ZADD NX** | Initialize without overwriting existing scores | 2,000 per sim start |
| **ZRANGEWITHSCORES** | Paginated retrieval (offset/limit via index range) | Page through 2K entries |
| **ZRANGEBYSCORE** | Score threshold filter + ship class filter (over-fetch + filter) | Filter across full set |
| **ZREVRANK** | O(log N) individual rank lookup | Per-profile queries |
| **ZCOUNT** | Count members in score range | Threshold badge |
| **ZCARD** | Total member count per window | Stats cards |
| **ZREMRANGEBYRANK** | Top-N cap enforcement per tick | Prune to top 10–500 |
| **HSET / HGETALL** | Ship metadata cache (fast enrichment on reads) | Batch 50–100 per page |
| **SCAN** | Safe key enumeration (reset, window discovery) | Pattern: `galactic:leaderboard:*` |
| **Pipelining (Batch)** | Bulk operations — one round-trip per tick per worker | 150 ops/batch × 40 workers |
| **TLS** | Encrypted transport (required by Serverless) | All connections |
| **Concurrent writers** | 40 Lambda workers writing to same sorted sets simultaneously | Valkey handles lock-free |

## Infrastructure (CDK)

```
galactic-mining-league/
├── bin/                      # CDK app entry point
├── lib/                      # CDK stack definition
│   └── galactic-mining-league-stack.ts
│       ├── VPC (2 AZ, NAT Gateway)
│       ├── Security Groups (Lambda ↔ Valkey)
│       ├── ElastiCache Valkey Serverless
│       ├── DynamoDB Table (PAY_PER_REQUEST)
│       ├── Lambda: API (NodejsFunction, esbuild bundled)
│       ├── Lambda: Worker (NodejsFunction, esbuild bundled)
│       ├── API Gateway HTTP API (9 route paths)
│       ├── S3 + CloudFront (OAC, SPA routing)
│       └── BucketDeployment (frontend + config.json)
├── lambda/
│   ├── api/handler.js        # All API routes (GLIDE + DynamoDB)
│   ├── worker/handler.js     # Simulation engine (fan-out ready)
│   └── package.json          # @valkey/valkey-glide + @aws-sdk
├── frontend/
│   ├── src/
│   │   ├── App.tsx           # Polling, pagination, filters, tabs
│   │   ├── api.ts            # API client (typed)
│   │   ├── types.ts          # TypeScript interfaces
│   │   └── components/
│   │       ├── Leaderboard.tsx       # Table with rank, bars, badges
│   │       └── SimulationControls.tsx # Fleet size, duration, mode, cap
│   └── build/                # Production build → S3
├── ARCHITECTURE.md           # This file
└── cdk.out/                  # Synthesized CloudFormation
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Valkey for leaderboard, DynamoDB for profiles | Sorted sets give O(log N) rank ops; DynamoDB gives durable identity that survives resets |
| Fan-out workers (not single Lambda) | Simulates realistic concurrent writer load; tests Valkey's lock-free sorted set under contention |
| `HSET` cache on every write | Avoids DynamoDB read on every leaderboard page render; Valkey hash is the "hot" metadata path |
| Server-side class filter via over-fetch | No native secondary index in sorted sets; scan-and-filter is fast enough for demo scale |
| Pagination via ZRANGEWITHSCORES offset | O(log N + M) — efficient for any page depth in Valkey |
| Time-windowed keys (daily/weekly/alltime) | Separate sorted sets per window = independent TTL, no cross-contamination |
| `ZADD GT` vs `ZINCRBY` toggle | Demonstrates two common leaderboard patterns in one demo |
| `ZREMRANGEBYRANK` per tick | Shows real-time pruning under write load |
