'use strict';

const crypto = require('crypto');
const { GlideClient, Batch, InfBoundary, UpdateByScore, TimeUnit } = require('@valkey/valkey-glide');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const PROFILES_TABLE = process.env.PROFILES_TABLE;
const LOADTEST_TABLE = process.env.LOADTEST_TABLE;

// ---------------------------------------------------------------------------
// Valkey GLIDE client — module-level, created lazily and reused across
// warm Lambda invocations. GlideClient.createClient() is async so we store
// the promise and await it on each invocation.
// ---------------------------------------------------------------------------
let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const [host, port] = process.env.VALKEY_ENDPOINT.split(':');
    clientPromise = GlideClient.createClient({
      addresses: [{ host, port: Number(port) || 6379 }],
      useTLS: true,
    });
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// AWS Lambda client for invoking the worker
// ---------------------------------------------------------------------------
const lambdaClient = new LambdaClient({});

// ---------------------------------------------------------------------------
// Ship classes and profile generation (single source of truth)
// ---------------------------------------------------------------------------
const SHIP_CLASSES = ['Excavator', 'Hauler', 'Dreadnought', 'Corvette', 'Scout'];

const NAME_PARTS = {
  prefixes: ['ISS', 'HMS', 'The', 'SS', 'MV', 'RV', 'GSV', 'GCU'],
  adjectives: ['Iron', 'Rusty', 'Stellar', 'Dark', 'Crimson', 'Golden', 'Frozen', 'Silent', 'Ancient', 'Blazing', 'Phantom', 'Neon', 'Cosmic', 'Quantum', 'Void', 'Solar', 'Savage', 'Swift', 'Heavy', 'Crystal'],
  nouns: ['Comet', 'Shard', 'Pilgrim', 'Drifter', 'Baron', 'Titan', 'Ghost', 'Runner', 'Hauler', 'Miner', 'Crusher', 'Bringer', 'Crawler', 'Skipper', 'Voyager', 'Hunter', 'Seeker', 'Strider', 'Falcon', 'Hammer'],
  firstNames: ['Zara', 'Kael', 'Nova', 'Rex', 'Lyra', 'Mace', 'Sable', 'Oren', 'Petra', 'Cass', 'Thane', 'Solis', 'Vela', 'Brynn', 'Finn', 'Juno', 'Axel', 'Dex', 'Mira', 'Silas', 'Kai', 'Ember', 'Rook', 'Sage', 'Wren', 'Jett', 'Vale', 'Nash', 'Cora', 'Blake'],
  lastNames: ['Voss', 'Dryden', 'Singh', 'Calloway', 'Okonkwo', 'Ferryn', 'Quinn', 'Takeda', 'Wolff', 'Alvarez', 'Moreau', 'Nakamura', 'Drakon', 'Sato', 'Osei', 'Reyes', 'Vance', 'Harlow', 'Fontaine', 'Crane', 'Zhao', 'Nkosi', 'Park', 'Rivera', 'Odin', 'Blix', 'Marsh', 'Kova', 'Zhen', 'Valk'],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateShipId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ship-${ts}${rand}`;
}

function generateProfile() {
  const now = new Date().toISOString();
  return {
    shipId: generateShipId(),
    shipName: `${pick(NAME_PARTS.prefixes)} ${pick(NAME_PARTS.adjectives)} ${pick(NAME_PARTS.nouns)}`,
    pilotName: `${pick(NAME_PARTS.firstNames)} ${pick(NAME_PARTS.lastNames)}`,
    shipClass: pick(SHIP_CLASSES),
    createdAt: now,
    lastActiveAt: now,
    totalSimulations: 0,
    lifetimeOreHauled: 0,
  };
}

// Starter fleet used only by POST /ships/seed
const SEED_FLEET = [
  { id: 'ship-001', shipName: 'ISS Ironclad',        pilotName: 'Zara Voss',      shipClass: 'Dreadnought' },
  { id: 'ship-002', shipName: 'The Rusty Comet',      pilotName: 'Kael Dryden',    shipClass: 'Excavator'   },
  { id: 'ship-003', shipName: 'Ore Crusher 9000',     pilotName: 'Nova Singh',     shipClass: 'Excavator'   },
  { id: 'ship-004', shipName: 'Stellar Shard',        pilotName: 'Rex Calloway',   shipClass: 'Hauler'      },
  { id: 'ship-005', shipName: 'Void Skipper',         pilotName: 'Lyra Okonkwo',   shipClass: 'Scout'       },
  { id: 'ship-006', shipName: 'Deep Vein Titan',      pilotName: 'Mace Ferryn',    shipClass: 'Dreadnought' },
  { id: 'ship-007', shipName: 'Crater Crawler',       pilotName: 'Sable Quinn',    shipClass: 'Excavator'   },
  { id: 'ship-008', shipName: 'Nebula Drifter',       pilotName: 'Oren Takeda',    shipClass: 'Scout'       },
  { id: 'ship-009', shipName: 'Quantum Hauler VII',   pilotName: 'Petra Wolff',    shipClass: 'Hauler'      },
  { id: 'ship-010', shipName: 'The Iron Pilgrim',     pilotName: 'Cass Alvarez',   shipClass: 'Corvette'    },
  { id: 'ship-011', shipName: 'Dust Bringer',         pilotName: 'Thane Moreau',   shipClass: 'Excavator'   },
  { id: 'ship-012', shipName: 'Meridian Ghost',       pilotName: 'Solis Nakamura', shipClass: 'Corvette'    },
  { id: 'ship-013', shipName: 'Comet Chaser III',     pilotName: 'Vela Drakon',    shipClass: 'Scout'       },
  { id: 'ship-014', shipName: 'ISS Colossus',         pilotName: 'Brynn Sato',     shipClass: 'Dreadnought' },
  { id: 'ship-015', shipName: 'Ore Baron',            pilotName: 'Finn Osei',      shipClass: 'Hauler'      },
  { id: 'ship-016', shipName: 'Pulsar Rig',           pilotName: 'Juno Reyes',     shipClass: 'Excavator'   },
  { id: 'ship-017', shipName: 'Shadow Corvette',      pilotName: 'Axel Vance',     shipClass: 'Corvette'    },
  { id: 'ship-018', shipName: 'The Galactic Mole',    pilotName: 'Dex Harlow',     shipClass: 'Excavator'   },
  { id: 'ship-019', shipName: 'Starfall Hauler',      pilotName: 'Mira Fontaine',  shipClass: 'Hauler'      },
  { id: 'ship-020', shipName: 'Eclipse Runner',       pilotName: 'Silas Crane',    shipClass: 'Scout'       },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

// hgetall in GLIDE returns {field, value}[] (direct) or {key, value}[] (batch).
// Handle both shapes and coerce to string.
function hashToObj(raw) {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return {};
  return Object.fromEntries(raw.map((f) => [String(f.field || f.key), String(f.value)]));
}

// ---------------------------------------------------------------------------
// Feature 1: Time-windowed leaderboard key helpers
// ---------------------------------------------------------------------------

/** Returns the key for today's daily leaderboard (UTC date). */
function getDailyKey() {
  const d = new Date();
  return `galactic:leaderboard:daily:${d.toISOString().slice(0, 10)}`;
}

/** Returns the key for the current ISO week leaderboard. */
function getWeeklyKey() {
  const d = new Date();
  const jan1 = new Date(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `galactic:leaderboard:weekly:${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const ALLTIME_KEY = 'galactic:leaderboard:alltime';

/**
 * Resolve which leaderboard key to query based on query params.
 * ?window=daily|weekly|alltime
 * ?date=YYYY-MM-DD   (for daily — defaults to today)
 * ?week=YYYY-Wnn     (for weekly — defaults to current week)
 */
function resolveWindowKey(window, queryParams) {
  if (window === 'daily') {
    const date = queryParams && queryParams.date;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return `galactic:leaderboard:daily:${date}`;
    }
    return getDailyKey();
  }
  if (window === 'weekly') {
    const week = queryParams && queryParams.week;
    if (week && /^\d{4}-W\d{2}$/.test(week)) {
      return `galactic:leaderboard:weekly:${week}`;
    }
    return getWeeklyKey();
  }
  return ALLTIME_KEY;
}

// ---------------------------------------------------------------------------
// Feature 4: Top-N cap helper — prune all three windows after a write batch
// ---------------------------------------------------------------------------

/**
 * If topN > 0, remove all entries ranked topN and below (0-based) from each
 * of the three window keys.  Pruning is best-effort — errors are logged but
 * do not fail the parent operation.
 */
async function applyTopNCap(client, topN) {
  if (!topN || topN <= 0) return;
  const keys = [ALLTIME_KEY, getDailyKey(), getWeeklyKey()];
  for (const key of keys) {
    try {
      // Keep ranks 0 … topN-1 (the top N).  Remove topN … end.
      await client.zremRangeByRank(key, topN, -1);
    } catch (err) {
      console.warn(`applyTopNCap: failed to prune ${key}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Route handlers — DynamoDB Ship Profiles
// ---------------------------------------------------------------------------

// GET /ships — list all ship profiles from DynamoDB
async function listShipProfiles() {
  const result = await ddbClient.send(new ScanCommand({ TableName: PROFILES_TABLE }));
  return respond(200, result.Items || []);
}

// GET /ships/{id} — get single profile with current leaderboard position
async function getShipProfile(client, shipId) {
  const [ddbResult, rankRaw, scoreRaw] = await Promise.all([
    ddbClient.send(new GetCommand({ TableName: PROFILES_TABLE, Key: { shipId } })),
    client.zrevrank('galactic:leaderboard:alltime', shipId),
    client.zscore('galactic:leaderboard:alltime', shipId),
  ]);
  if (!ddbResult.Item) {
    return respond(404, { message: `Ship ${shipId} not found` });
  }
  return respond(200, {
    ...ddbResult.Item,
    currentRank: rankRaw !== null ? Number(rankRaw) + 1 : null,
    currentScore: scoreRaw !== null ? Number(scoreRaw) : null,
  });
}

// POST /ships — create a single ship profile
async function createShipProfile(client, body) {
  let parsed;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch { return respond(400, { message: 'Invalid JSON' }); }

  const { shipId, shipName, pilotName, shipClass } = parsed || {};
  if (!shipId || !shipName || !pilotName || !shipClass) {
    return respond(400, { message: 'shipId, shipName, pilotName, and shipClass are required' });
  }

  const now = new Date().toISOString();
  const item = { shipId, shipName, pilotName, shipClass, createdAt: now, lastActiveAt: now, totalSimulations: 0, lifetimeOreHauled: 0 };

  await ddbClient.send(new PutCommand({ TableName: PROFILES_TABLE, Item: item }));
  // Cache in Valkey for fast leaderboard enrichment
  await client.hset(`ship:${shipId}`, { shipName, pilotName, shipClass });

  return respond(201, item);
}

// POST /ships/seed — bulk-seed all 20 ships from SEED_FLEET into DynamoDB
async function seedShipProfiles(client) {
  const now = new Date().toISOString();
  // DynamoDB BatchWrite (max 25 items per batch — we have 20 so one batch is fine)
  const items = SEED_FLEET.map(s => ({
    PutRequest: {
      Item: { shipId: s.id, shipName: s.shipName, pilotName: s.pilotName, shipClass: s.shipClass, createdAt: now, lastActiveAt: now, totalSimulations: 0, lifetimeOreHauled: 0 }
    }
  }));

  await ddbClient.send(new BatchWriteCommand({ RequestItems: { [PROFILES_TABLE]: items } }));

  // Also cache all in Valkey
  const batch = new Batch(false);
  for (const s of SEED_FLEET) {
    batch.hset(`ship:${s.id}`, { shipName: s.shipName, pilotName: s.pilotName, shipClass: s.shipClass });
  }
  await client.exec(batch, false);

  return respond(200, { message: `Seeded ${SEED_FLEET.length} ship profiles`, count: SEED_FLEET.length });
}

// POST /ships/generate — bulk-create N synthetic ship profiles
async function generateShipProfiles(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch {
    return respond(400, { message: 'Invalid JSON' });
  }

  const count = Math.min(Math.max(Number(parsed.count) || 100, 1), 5000);

  const profiles = [];
  for (let i = 0; i < count; i++) {
    profiles.push(generateProfile());
  }

  // BatchWrite in groups of 25
  for (let i = 0; i < profiles.length; i += 25) {
    const batch = profiles.slice(i, i + 25).map(p => ({
      PutRequest: { Item: p },
    }));
    await ddbClient.send(new BatchWriteCommand({
      RequestItems: { [PROFILES_TABLE]: batch },
    }));
  }

  return respond(200, {
    message: `Generated ${profiles.length} ship profiles`,
    count: profiles.length,
    sampleIds: profiles.slice(0, 5).map(p => p.shipId),
  });
}

// ---------------------------------------------------------------------------
// Route handlers — Leaderboard
// ---------------------------------------------------------------------------

// GET /leaderboard?window=alltime|daily|weekly&offset=0&limit=50&shipClass=Excavator
async function getLeaderboard(client, queryParams) {
  const window = (queryParams && queryParams.window) || 'alltime';
  const leaderboardKey = resolveWindowKey(window, queryParams);
  const classFilter = queryParams?.shipClass || null;

  const offset = Math.max(0, Number(queryParams?.offset) || 0);
  const limit = Math.min(Math.max(1, Number(queryParams?.limit) || 50), 100);

  const totalRaw = await client.zcard(leaderboardKey);
  const totalAll = Number(totalRaw);

  if (totalAll === 0) {
    return respond(200, {
      entries: [],
      pagination: { offset, limit, count: 0, total: 0, hasMore: false },
      filter: classFilter ? { shipClass: classFilter } : null,
    });
  }

  // Without class filter: simple range query
  if (!classFilter) {
    const results = await client.zrangeWithScores(
      leaderboardKey, { start: offset, end: offset + limit - 1 }, { reverse: true },
    );

    if (!results || results.length === 0) {
      return respond(200, {
        entries: [],
        pagination: { offset, limit, count: 0, total: totalAll, hasMore: false },
        filter: null,
      });
    }

    const batch = new Batch(false);
    for (const entry of results) {
      batch.hgetall(`ship:${String(entry.element)}`);
    }
    const metaResults = await client.exec(batch, false);

    const entries = results.map((entry, i) => {
      const shipId = String(entry.element);
      const meta = hashToObj(metaResults && metaResults[i]);
  
      return {
        rank: offset + i + 1,
        shipId,
        score: Number(entry.score),
        shipName: meta.shipName || 'Unknown',
        pilotName: meta.pilotName || 'Unknown',
        shipClass: meta.shipClass || 'Unknown',
        totalSimulations: Number(meta.totalSimulations) || 0,
        lifetimeOreHauled: Number(meta.lifetimeOreHauled) || 0,
      };
    });

    return respond(200, {
      entries,
      pagination: { offset, limit, count: entries.length, total: totalAll, hasMore: offset + entries.length < totalAll },
      filter: null,
    });
  }

  // With class filter: scan in batches of 200, collect matches until we have
  // enough to fill offset + limit, then slice.
  const needed = offset + limit;
  const SCAN_BATCH = 200;
  let cursor = 0;
  const filtered = [];

  while (filtered.length < needed && cursor < totalAll) {
    const batchEnd = Math.min(cursor + SCAN_BATCH - 1, totalAll - 1);
    const results = await client.zrangeWithScores(
      leaderboardKey, { start: cursor, end: batchEnd }, { reverse: true },
    );
    if (!results || results.length === 0) break;

    const metaBatch = new Batch(false);
    for (const entry of results) {
      metaBatch.hgetall(`ship:${String(entry.element)}`);
    }
    const metaResults = await client.exec(metaBatch, false);

    for (let i = 0; i < results.length; i++) {
      const meta = hashToObj(metaResults && metaResults[i]);
      const shipId = String(results[i].element);
  
      const shipClass = meta.shipClass || 'Unknown';
      if (shipClass === classFilter) {
        filtered.push({
          shipId,
          score: Number(results[i].score),
          shipName: meta.shipName || 'Unknown',
          pilotName: meta.pilotName || 'Unknown',
          shipClass,
        });
      }
    }
    cursor += results.length;
  }

  // We may not have scanned the entire set, so filteredTotal is approximate
  // unless we scanned everything
  const scannedAll = cursor >= totalAll;
  const filteredTotal = scannedAll ? filtered.length : null;
  const page = filtered.slice(offset, offset + limit);
  const entries = page.map((e, i) => ({ ...e, rank: offset + i + 1 }));

  return respond(200, {
    entries,
    pagination: {
      offset,
      limit,
      count: entries.length,
      total: filteredTotal !== null ? filteredTotal : totalAll,
      hasMore: !scannedAll || (offset + entries.length < filtered.length),
    },
    filter: { shipClass: classFilter },
  });
}

// GET /leaderboard/windows — discover all available time windows
async function getLeaderboardWindows(client) {
  const alltimeCount = await client.zcard(ALLTIME_KEY);

  // Scan for all daily and weekly keys to populate selectors
  const dailyDates = [];
  const weeklyWeeks = [];

  let cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: 'galactic:leaderboard:daily:*', count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      const date = key.replace('galactic:leaderboard:daily:', '');
      dailyDates.push(date);
    }
  } while (cursor !== '0');

  cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: 'galactic:leaderboard:weekly:*', count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      const week = key.replace('galactic:leaderboard:weekly:', '');
      weeklyWeeks.push(week);
    }
  } while (cursor !== '0');

  dailyDates.sort().reverse();
  weeklyWeeks.sort().reverse();

  return respond(200, {
    alltime: alltimeCount > 0,
    daily: dailyDates,
    weekly: weeklyWeeks,
  });
}

// GET /leaderboard/stats — ship counts per window (Feature 5)
async function getLeaderboardStats(client) {
  const dailyKey = getDailyKey();
  const weeklyKey = getWeeklyKey();

  const [alltimeCount, dailyCount, weeklyCount] = await Promise.all([
    client.zcard(ALLTIME_KEY),
    client.zcard(dailyKey),
    client.zcard(weeklyKey),
  ]);

  return respond(200, {
    alltime: { shipCount: Number(alltimeCount), key: ALLTIME_KEY },
    daily:   { shipCount: Number(dailyCount),   key: dailyKey   },
    weekly:  { shipCount: Number(weeklyCount),  key: weeklyKey  },
  });
}

// GET /leaderboard/above/{threshold}?window=alltime|daily|weekly&offset=0&limit=50 (Feature 3)
async function getLeaderboardAbove(client, threshold, queryParams) {
  const parsed = Number(threshold);
  if (!isFinite(parsed)) {
    return respond(400, { message: 'threshold must be a number' });
  }

  const window = (queryParams && queryParams.window) || 'alltime';
  const leaderboardKey = resolveWindowKey(window, queryParams);
  const classFilter = queryParams?.shipClass || null;

  const offset = Math.max(0, Number(queryParams?.offset) || 0);
  const limit = Math.min(Math.max(1, Number(queryParams?.limit) || 50), 100);

  // Fetch all entries with score >= threshold, highest first.
  const allResults = await client.zrangeWithScores(
    leaderboardKey,
    {
      type: 'byScore',
      start: InfBoundary.PositiveInfinity,
      end: { value: parsed, isInclusive: true },
    },
    { reverse: true },
  );

  if (!allResults || allResults.length === 0) {
    return respond(200, {
      count: 0,
      entries: [],
      pagination: { offset, limit, count: 0, total: 0, hasMore: false },
      filter: classFilter ? { shipClass: classFilter, threshold: parsed } : { threshold: parsed },
    });
  }

  // Enrich all results with metadata (needed for class filtering)
  // Process in batches of 200 to avoid oversized pipelines
  const enriched = [];
  const ENRICH_BATCH = 200;
  for (let i = 0; i < allResults.length; i += ENRICH_BATCH) {
    const chunk = allResults.slice(i, i + ENRICH_BATCH);
    const metaBatch = new Batch(false);
    for (const entry of chunk) {
      metaBatch.hgetall(`ship:${String(entry.element)}`);
    }
    const metaResults = await client.exec(metaBatch, false) || [];

    for (let j = 0; j < chunk.length; j++) {
      const meta = hashToObj(metaResults[j]);
      const shipClass = meta.shipClass || 'Unknown';
      if (!classFilter || shipClass === classFilter) {
        enriched.push({
          shipId: String(chunk[j].element),
          score: Number(chunk[j].score),
          shipName: meta.shipName || 'Unknown',
          pilotName: meta.pilotName || 'Unknown',
          shipClass,
        });
      }
    }

    // Early exit: if we have enough for offset + limit and no class filter, stop
    if (!classFilter && enriched.length >= offset + limit) break;
  }

  const total = enriched.length;
  const page = enriched.slice(offset, offset + limit);
  const entries = page.map((e, i) => ({ ...e, rank: offset + i + 1 }));

  return respond(200, {
    count: total,
    entries,
    pagination: {
      offset,
      limit,
      count: entries.length,
      total,
      hasMore: offset + entries.length < total,
    },
    filter: classFilter ? { shipClass: classFilter, threshold: parsed } : { threshold: parsed },
  });
}

// GET /ships/{id}/rank?window=alltime|daily|weekly
async function getShipRank(client, shipId, queryParams) {
  const window = (queryParams && queryParams.window) || 'alltime';
  const leaderboardKey = resolveWindowKey(window, queryParams);

  const [rankRaw, scoreRaw, rawMeta] = await Promise.all([
    client.zrevrank(leaderboardKey, shipId),
    client.zscore(leaderboardKey, shipId),
    client.hgetall(`ship:${shipId}`),
  ]);

  if (rankRaw === null) {
    return respond(404, { message: `Ship ${shipId} not found on leaderboard` });
  }

  const meta = hashToObj(rawMeta);
  return respond(200, {
    shipId,
    rank: Number(rankRaw) + 1,
    score: Number(scoreRaw),
    window,
    shipName: meta.shipName || 'Unknown',
    pilotName: meta.pilotName || 'Unknown',
    shipClass: meta.shipClass || 'Unknown',
  });
}

// POST /ships/{id}/score  body: { score: number, updatePolicy?: 'cumulative'|'best', topN?: number }
async function postShipScore(client, shipId, body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return respond(400, { message: 'Invalid JSON body' });
  }

  const increment = Number(parsed && parsed.score);
  if (!isFinite(increment)) {
    return respond(400, { message: 'Body must contain a numeric "score" field' });
  }

  const updatePolicy = (parsed && parsed.updatePolicy) || 'cumulative';
  const topN = Number(parsed && parsed.topN) || 0;

  const allKeys = [ALLTIME_KEY, getDailyKey(), getWeeklyKey()];
  let newScore;

  if (updatePolicy === 'best') {
    // Feature 2: ZADD GT — only update if the new score is higher
    for (const key of allKeys) {
      await client.zadd(
        key,
        [{ element: shipId, score: increment }],
        { updateOptions: UpdateByScore.GREATER_THAN },
      );
    }
    // Read back the current score from alltime
    const scoreRaw = await client.zscore(ALLTIME_KEY, shipId);
    newScore = Number(scoreRaw);
  } else {
    // Feature 1: ZINCRBY into all three time-windowed keys
    const scoreRaw = await client.zincrby(ALLTIME_KEY, increment, shipId);
    newScore = Number(scoreRaw);
    await Promise.all([
      client.zincrby(getDailyKey(), increment, shipId),
      client.zincrby(getWeeklyKey(), increment, shipId),
    ]);
  }

  // Feature 4: apply top-N cap if requested
  await applyTopNCap(client, topN);

  return respond(200, { shipId, score: newScore });
}

// POST /simulation/start — fan-out to multiple worker Lambdas
async function startSimulation(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch {
    parsed = {};
  }

  const shipCount    = Math.min(Number(parsed.shipCount) || 10, 10000);
  const duration     = Number(parsed.duration)     || 60;
  const updatePolicy = parsed.updatePolicy === 'best' ? 'best' : 'cumulative';
  const topN         = Number(parsed.topN)         || 0;
  const chunkSize    = Math.min(Number(parsed.chunkSize) || 50, 200);

  const workerArn = process.env.WORKER_LAMBDA_ARN;
  if (!workerArn) {
    return respond(500, { message: 'WORKER_LAMBDA_ARN environment variable is not set' });
  }

  // Load ship profiles from DynamoDB
  let allProfiles = [];
  if (PROFILES_TABLE) {
    let lastKey;
    do {
      const scanResult = await ddbClient.send(new ScanCommand({
        TableName: PROFILES_TABLE,
        ExclusiveStartKey: lastKey,
        Limit: 1000,
      }));
      allProfiles.push(...(scanResult.Items || []));
      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);
  }

  // If not enough profiles, auto-generate to meet the requested count
  if (allProfiles.length < shipCount && PROFILES_TABLE) {
    const needed = shipCount - allProfiles.length;
    const generated = [];
    for (let i = 0; i < needed; i++) {
      generated.push(generateProfile());
    }

    for (let i = 0; i < generated.length; i += 25) {
      const batch = generated.slice(i, i + 25).map(p => ({ PutRequest: { Item: p } }));
      await ddbClient.send(new BatchWriteCommand({ RequestItems: { [PROFILES_TABLE]: batch } }));
    }

    allProfiles.push(...generated);
    console.log(`Auto-generated ${needed} profiles to meet requested shipCount=${shipCount}`);
  }

  if (allProfiles.length === 0) {
    allProfiles = SEED_FLEET.map(s => ({
      shipId: s.id, shipName: s.shipName, pilotName: s.pilotName, shipClass: s.shipClass,
    }));
  }

  // Sample shipCount profiles (or take all if shipCount >= total)
  let selectedShips;
  if (shipCount >= allProfiles.length) {
    selectedShips = allProfiles;
  } else {
    // Fisher-Yates partial shuffle
    const copy = [...allProfiles];
    selectedShips = [];
    for (let i = 0; i < shipCount; i++) {
      const idx = Math.floor(Math.random() * copy.length);
      selectedShips.push(copy.splice(idx, 1)[0]);
    }
  }

  // Cache selected profiles in Valkey as an ephemeral session.
  // Workers pull their slice from cache instead of receiving full profile
  // data in the invoke payload (avoids 256KB Lambda payload limit at scale).
  const client = await getClient();
  const sessionId = `sim-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const sessionKey = `session:${sessionId}`;
  const sessionTtl = duration + 300; // keep cache alive for sim duration + 5 min buffer
  await client.set(sessionKey, JSON.stringify(selectedShips), { expiry: { type: TimeUnit.Seconds, count: sessionTtl } });

  // Fan out workers with lightweight payload — just session reference + slice indices
  const totalShips = selectedShips.length;
  const chunks = [];
  for (let i = 0; i < totalShips; i += chunkSize) {
    chunks.push({ startIndex: i, count: Math.min(chunkSize, totalShips - i) });
  }

  const invokePromises = chunks.map((chunk, idx) =>
    lambdaClient.send(new InvokeCommand({
      FunctionName: workerArn,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({
        sessionKey,
        startIndex: chunk.startIndex,
        shipCount: chunk.count,
        duration,
        updatePolicy,
        topN,
        workerId: idx,
      })),
    }))
  );

  await Promise.all(invokePromises);

  return respond(202, {
    message: 'Simulation launched',
    sessionKey,
    shipCount: selectedShips.length,
    workerCount: chunks.length,
    chunkSize,
    duration,
    updatePolicy,
    topN,
  });
}

// ---------------------------------------------------------------------------
// Route handlers — Load Testing
// ---------------------------------------------------------------------------

// POST /loadtest/start — Starts a phased load test
async function startLoadTest(body) {
  let parsed;
  try { parsed = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {}); }
  catch { return respond(400, { message: 'Invalid JSON' }); }

  const testId = `lt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const phases = parsed.phases || [
    { duration: 30, writers: 5, shipsPerWriter: 50 },
    { duration: 30, writers: 20, shipsPerWriter: 50 },
    { duration: 30, writers: 50, shipsPerWriter: 50 },
  ];
  const tickInterval = Number(parsed.tickInterval) || 500;
  const updatePolicy = parsed.updatePolicy || 'cumulative';

  // Write test metadata
  await ddbClient.send(new PutCommand({
    TableName: LOADTEST_TABLE,
    Item: {
      testId,
      recordType: 'metadata',
      status: 'running',
      phases,
      tickInterval,
      updatePolicy,
      startedAt: new Date().toISOString(),
      totalWriters: phases.reduce((sum, p) => sum + p.writers, 0),
      totalShips: phases.reduce((sum, p) => sum + p.writers * p.shipsPerWriter, 0),
    },
  }));

  // Load/generate profiles for all phases
  const maxShips = phases.reduce((max, p) => Math.max(max, p.writers * p.shipsPerWriter), 0);

  // Load all profiles from DynamoDB
  let allProfiles = [];
  if (PROFILES_TABLE) {
    let lastKey;
    do {
      const scanResult = await ddbClient.send(new ScanCommand({
        TableName: PROFILES_TABLE,
        ExclusiveStartKey: lastKey,
        Limit: 1000,
      }));
      allProfiles.push(...(scanResult.Items || []));
      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);
  }

  // Auto-generate if needed
  if (allProfiles.length < maxShips && PROFILES_TABLE) {
    const needed = maxShips - allProfiles.length;
    const generated = [];
    for (let i = 0; i < needed; i++) {
      generated.push(generateProfile());
    }
    for (let i = 0; i < generated.length; i += 25) {
      const batch = generated.slice(i, i + 25).map(p => ({ PutRequest: { Item: p } }));
      await ddbClient.send(new BatchWriteCommand({ RequestItems: { [PROFILES_TABLE]: batch } }));
    }
    allProfiles.push(...generated);
  }

  // Cache all profiles in Valkey session for workers to pull from
  const client = await getClient();
  const sessionKey = `session:${testId}`;
  const totalDuration = phases.reduce((sum, p) => sum + p.duration, 0);
  const sessionTtl = totalDuration + 300;
  await client.set(sessionKey, JSON.stringify(allProfiles), { expiry: { type: TimeUnit.Seconds, count: sessionTtl } });

  // Launch all phases with staggered start delays — workers reference the session
  const workerArn = process.env.WORKER_LAMBDA_ARN;
  let globalWorkerIdx = 0;
  let phaseStartDelay = 0;

  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
    const phase = phases[phaseIdx];

    for (let w = 0; w < phase.writers; w++) {
      const startIndex = w * phase.shipsPerWriter;
      await lambdaClient.send(new InvokeCommand({
        FunctionName: workerArn,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          sessionKey,
          startIndex,
          shipCount: phase.shipsPerWriter,
          duration: phase.duration,
          updatePolicy,
          topN: 0,
          workerId: globalWorkerIdx,
          loadTestId: testId,
          startDelay: phaseStartDelay,
          tickInterval,
          phase: phaseIdx,
        })),
      }));
      globalWorkerIdx++;
    }
    phaseStartDelay += phase.duration;
  }

  return respond(202, {
    message: 'Load test started',
    testId,
    sessionKey,
    phases,
    totalWriters: globalWorkerIdx,
    estimatedDuration: phaseStartDelay,
  });
}

// GET /events?since={id}&limit=50 — read from the event stream
async function getEvents(client, queryParams) {
  const since = (queryParams && queryParams.since) || '0-0';
  const limit = Math.min(Math.max(1, Number(queryParams?.limit) || 50), 200);

  // XRANGE: get entries after `since` (exclusive — use since as start, then skip first if it matches)
  // Actually XRANGE is inclusive, so to get "after since" we use the next possible ID
  const startId = since === '0-0' ? '-' : `(${since}`;

  // GLIDE xrange uses Boundary<string> — InfBoundary.NegativeInfinity for "-"
  let results;
  if (since === '0-0') {
    results = await client.xrange(
      'galactic:events',
      InfBoundary.NegativeInfinity,
      InfBoundary.PositiveInfinity,
      { count: limit },
    );
  } else {
    // Exclusive start: use the ID format "(id" — GLIDE uses Boundary with isInclusive
    results = await client.xrange(
      'galactic:events',
      { value: since, isInclusive: false },
      InfBoundary.PositiveInfinity,
      { count: limit },
    );
  }

  // xrange returns Record<string, [GlideString, GlideString][]> | null
  // Keys are stream entry IDs, values are arrays of [field, value] pairs
  const events = [];
  if (results && typeof results === 'object') {
    const entries = Object.entries(results);
    for (const [id, fieldPairs] of entries) {
      const fields = {};
      if (Array.isArray(fieldPairs)) {
        for (const pair of fieldPairs) {
          fields[String(pair[0])] = String(pair[1]);
        }
      }
      events.push({ id: String(id), ...fields });
    }
  }

  const streamLen = await client.xlen('galactic:events');

  return respond(200, {
    events,
    count: events.length,
    streamLength: Number(streamLen),
    lastId: events.length > 0 ? events[events.length - 1].id : since,
  });
}

// GET /loadtests — List all load tests
async function listLoadTests() {
  const result = await ddbClient.send(new ScanCommand({
    TableName: LOADTEST_TABLE,
    FilterExpression: 'recordType = :meta',
    ExpressionAttributeValues: { ':meta': 'metadata' },
  }));
  const tests = (result.Items || []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return respond(200, tests);
}

// GET /loadtest/{id} — Get full results for a test
async function getLoadTestResults(testId) {
  // Query all records for this testId (metadata + worker results)
  const result = await ddbClient.send(new ScanCommand({
    TableName: LOADTEST_TABLE,
    FilterExpression: 'testId = :id',
    ExpressionAttributeValues: { ':id': testId },
  }));

  const items = result.Items || [];
  const metadata = items.find(i => i.recordType === 'metadata');
  const workerResults = items.filter(i => i.recordType.startsWith('worker-'))
    .sort((a, b) => a.workerId - b.workerId);

  if (!metadata) {
    return respond(404, { message: 'Load test not found' });
  }

  // Aggregate stats
  const totalOps = workerResults.reduce((sum, w) => sum + (w.totalUpdates || 0), 0);
  const allLatencies = workerResults.filter(w => w.latencyMs);

  let aggregateLatency = null;
  if (allLatencies.length > 0) {
    const p50s = allLatencies.map(w => w.latencyMs.p50);
    const p95s = allLatencies.map(w => w.latencyMs.p95);
    const p99s = allLatencies.map(w => w.latencyMs.p99);
    const maxes = allLatencies.map(w => w.latencyMs.max);
    aggregateLatency = {
      p50: Number((p50s.reduce((a, b) => a + b, 0) / p50s.length).toFixed(2)),
      p95: Number((p95s.reduce((a, b) => a + b, 0) / p95s.length).toFixed(2)),
      p99: Number((p99s.reduce((a, b) => a + b, 0) / p99s.length).toFixed(2)),
      max: Number(Math.max(...maxes).toFixed(2)),
    };
  }

  const totalDuration = metadata.phases.reduce((sum, p) => sum + p.duration, 0);
  const completedWorkers = workerResults.length;
  const expectedWorkers = metadata.totalWriters;

  // Update status if all workers reported
  if (completedWorkers >= expectedWorkers && metadata.status === 'running') {
    await ddbClient.send(new UpdateCommand({
      TableName: LOADTEST_TABLE,
      Key: { testId, recordType: 'metadata' },
      UpdateExpression: 'SET #s = :done, completedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':done': 'completed', ':now': new Date().toISOString() },
    }));
    metadata.status = 'completed';
  }

  return respond(200, {
    ...metadata,
    results: {
      completedWorkers,
      expectedWorkers,
      totalOps,
      aggregateOpsPerSecond: Math.round(totalOps / totalDuration),
      aggregateLatency,
      workers: workerResults,
    },
  });
}

// POST /leaderboard/topn — apply top-N pruning to a specific window (Feature 4)
async function postLeaderboardTopN(client, body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch {
    return respond(400, { message: 'Invalid JSON body' });
  }

  const topN   = Number(parsed && parsed.topN);
  const window = (parsed && parsed.window) || 'alltime';
  const queryParams = parsed;

  if (!isFinite(topN) || topN <= 0) {
    return respond(400, { message: '"topN" must be a positive number' });
  }

  const leaderboardKey = resolveWindowKey(window, queryParams);

  // Remove all entries ranked topN and below (0-based), keeping only the top N
  await client.zremRangeByRank(leaderboardKey, topN, -1);

  const remaining = await client.zcard(leaderboardKey);
  return respond(200, { message: `Pruned to top ${topN}`, window, key: leaderboardKey, remaining: Number(remaining) });
}

// DELETE /leaderboard — reset all leaderboard data (all three windows + ship hashes)
async function resetLeaderboard(client) {
  // Delete the canonical alltime key, today's daily key, and this week's weekly key
  await client.del([ALLTIME_KEY]);
  await client.del([getDailyKey()]);
  await client.del([getWeeklyKey()]);

  // Scan and delete any remaining galactic:leaderboard:daily:* keys
  let cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: 'galactic:leaderboard:daily:*', count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      await client.del([key]);
    }
  } while (cursor !== '0');

  // Scan and delete any remaining galactic:leaderboard:weekly:* keys
  cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: 'galactic:leaderboard:weekly:*', count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      await client.del([key]);
    }
  } while (cursor !== '0');

  // Scan and delete ship:* hash keys one at a time to avoid CrossSlot errors
  // (ElastiCache Serverless uses cluster-mode routing internally)
  cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, { match: 'ship:*', count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      await client.del([key]);
    }
  } while (cursor !== '0');

  return respond(200, { message: 'Leaderboard reset' });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    const client      = await getClient();
    const routeKey    = event.routeKey || `${event.httpMethod} ${event.path}`;
    const pathParams  = event.pathParameters || {};
    const queryParams = event.queryStringParameters || {};

    switch (routeKey) {
      // Feature 1: window-aware leaderboard
      case 'GET /leaderboard':
        return await getLeaderboard(client, queryParams);

      // Feature 1: which windows have data
      case 'GET /leaderboard/windows':
        return await getLeaderboardWindows(client);

      // Feature 5: live ship-count badge
      case 'GET /leaderboard/stats':
        return await getLeaderboardStats(client);

      // Feature 3: score threshold filter
      case 'GET /leaderboard/above/{threshold}':
        return await getLeaderboardAbove(client, pathParams.threshold, queryParams);

      // DynamoDB ship profiles
      case 'GET /ships':
        return await listShipProfiles();
      case 'GET /ships/{id}':
        return await getShipProfile(client, pathParams.id);
      case 'POST /ships':
        return await createShipProfile(client, event.body);
      case 'POST /ships/seed':
        return await seedShipProfiles(client);
      case 'POST /ships/generate':
        return await generateShipProfiles(event.body);

      // Feature 1: window-aware rank lookup
      case 'GET /ships/{id}/rank':
        return await getShipRank(client, pathParams.id, queryParams);

      case 'POST /ships/{id}/score':
        return await postShipScore(client, pathParams.id, event.body);

      case 'POST /simulation/start':
        return await startSimulation(event.body);

      // Load testing
      case 'POST /loadtest/start':
        return await startLoadTest(event.body);
      case 'GET /loadtest/{id}':
        return await getLoadTestResults(pathParams.id);
      case 'GET /loadtests':
        return await listLoadTests();

      // Event stream
      case 'GET /events':
        return await getEvents(client, queryParams);

      // Feature 4: explicit top-N pruning endpoint
      case 'POST /leaderboard/topn':
        return await postLeaderboardTopN(client, event.body);

      case 'DELETE /leaderboard':
        return await resetLeaderboard(client);

      case 'OPTIONS /ships':
      case 'OPTIONS /ships/{id}':
      case 'OPTIONS /ships/seed':
      case 'OPTIONS /leaderboard':
      case 'OPTIONS /leaderboard/windows':
      case 'OPTIONS /leaderboard/stats':
      case 'OPTIONS /leaderboard/above/{threshold}':
      case 'OPTIONS /leaderboard/topn':
      case 'OPTIONS /ships/{id}/rank':
      case 'OPTIONS /ships/{id}/score':
      case 'OPTIONS /simulation/start':
      case 'OPTIONS /events':
      case 'OPTIONS /loadtest/start':
      case 'OPTIONS /loadtest/{id}':
      case 'OPTIONS /loadtests':
        return respond(200, {});

      default:
        return respond(404, { message: `Route not found: ${routeKey}` });
    }
  } catch (err) {
    console.error('Unhandled error in API handler:', err);
    return respond(500, { message: 'Internal server error', error: err.message });
  }
};
