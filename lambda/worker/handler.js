'use strict';

const { GlideClient, Batch, ConditionalChange, UpdateByScore } = require('@valkey/valkey-glide');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const PROFILES_TABLE = process.env.PROFILES_TABLE;
const LOADTEST_TABLE = process.env.LOADTEST_TABLE;

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

function getDailyKey() {
  const d = new Date();
  return `galactic:leaderboard:daily:${d.toISOString().slice(0, 10)}`;
}

function getWeeklyKey() {
  const d = new Date();
  const jan1 = new Date(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getUTCDay() + 1) / 7);
  return `galactic:leaderboard:weekly:${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const CLASS_RANGES = {
  Excavator:   { min: 200, max: 500 },
  Hauler:      { min: 180, max: 450 },
  Dreadnought: { min: 120, max: 380 },
  Corvette:    { min: 80,  max: 300 },
  Scout:       { min: 50,  max: 180 },
};

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function oreHaulForClass(shipClass) {
  const range = CLASS_RANGES[shipClass] || CLASS_RANGES.Scout;
  return randomInt(range.min, range.max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main handler
//
// Event shape:
// {
//   ships: [{shipId, shipName, pilotName, shipClass}, ...],  // pre-sliced chunk
//   duration: 60,
//   updatePolicy: "cumulative" | "best",
//   topN: 0,
//   workerId: 3   // for logging
// }
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  try {
    const client = await getClient();

    // Load ships: either from Valkey session cache (preferred) or directly from event payload (fallback)
    let ships;
    if (event.sessionKey) {
      const raw = await client.get(event.sessionKey);
      if (!raw) {
        return { message: 'Session expired or not found', sessionKey: event.sessionKey, shipsSimulated: 0 };
      }
      const allShips = JSON.parse(raw);
      const start = Number(event.startIndex) || 0;
      const count = Number(event.shipCount) || allShips.length;
      ships = allShips.slice(start, start + count);
    } else {
      ships = event.ships || [];
    }

    if (ships.length === 0) {
      return { message: 'No ships provided', shipsSimulated: 0 };
    }

    const duration = Math.max(1, Math.min(Number(event.duration) || 60, 240));
    const updatePolicy = event.updatePolicy === 'best' ? 'best' : 'cumulative';
    const topN = Math.max(0, Number(event.topN) || 0);
    const workerId = event.workerId || 0;
    const tickIntervalMs = Number(event.tickInterval) || 500;

    // Phased load test: delay start if requested
    const startDelay = Number(event.startDelay) || 0;
    if (startDelay > 0) {
      console.log(`Worker ${workerId}: waiting ${startDelay}s before starting (phased ramp)`);
      await sleep(startDelay * 1000);
    }

    console.log(`Worker ${workerId}: ${ships.length} ships, ${duration}s, policy=${updatePolicy}, topN=${topN}, tickInterval=${tickIntervalMs}ms`);

    const alltimeKey = 'galactic:leaderboard:alltime';
    const dailyKey   = getDailyKey();
    const weeklyKey  = getWeeklyKey();

    // Registration: write metadata to Valkey hash + ZADD NX to all 3 sorted sets
    // Batch in chunks of 100 to avoid oversized pipelines
    const BATCH_SIZE = 100;
    for (let i = 0; i < ships.length; i += BATCH_SIZE) {
      const chunk = ships.slice(i, i + BATCH_SIZE);
      const registerBatch = new Batch(false);
      for (const ship of chunk) {
        registerBatch.hset(`ship:${ship.shipId}`, {
          shipName: ship.shipName,
          pilotName: ship.pilotName,
          shipClass: ship.shipClass,
        });
        const nxOpts = { conditionalChange: ConditionalChange.ONLY_IF_DOES_NOT_EXIST };
        registerBatch.zadd(alltimeKey, [{ element: ship.shipId, score: 0 }], nxOpts);
        registerBatch.zadd(dailyKey,   [{ element: ship.shipId, score: 0 }], nxOpts);
        registerBatch.zadd(weeklyKey,  [{ element: ship.shipId, score: 0 }], nxOpts);
      }
      await client.exec(registerBatch, false);
    }

    // Mining loop
    const totalTicks = Math.floor((duration * 1000) / tickIntervalMs);
    let totalUpdates = 0;
    const latencies = [];

    const oreEarned = {};
    for (const s of ships) oreEarned[s.shipId] = 0;

    for (let tick = 0; tick < totalTicks; tick++) {
      const tickStart = Date.now();

      // Batch tick updates in chunks to keep pipeline size reasonable
      for (let i = 0; i < ships.length; i += BATCH_SIZE) {
        const chunk = ships.slice(i, i + BATCH_SIZE);
        const tickBatch = new Batch(false);
        for (const ship of chunk) {
          const haul = oreHaulForClass(ship.shipClass);
          oreEarned[ship.shipId] += haul;
          if (updatePolicy === 'best') {
            tickBatch.zadd(alltimeKey, [{ element: ship.shipId, score: haul }], { updateOptions: UpdateByScore.GREATER_THAN });
            tickBatch.zadd(dailyKey,   [{ element: ship.shipId, score: haul }], { updateOptions: UpdateByScore.GREATER_THAN });
            tickBatch.zadd(weeklyKey,  [{ element: ship.shipId, score: haul }], { updateOptions: UpdateByScore.GREATER_THAN });
          } else {
            tickBatch.zincrby(alltimeKey, haul, ship.shipId);
            tickBatch.zincrby(dailyKey,   haul, ship.shipId);
            tickBatch.zincrby(weeklyKey,  haul, ship.shipId);
          }
          totalUpdates++;
        }
        const t0 = process.hrtime.bigint();
        await client.exec(tickBatch, false);
        const elapsed = Number(process.hrtime.bigint() - t0) / 1e6; // ms
        latencies.push(elapsed);
      }

      if (topN > 0) {
        await Promise.all([
          client.zremRangeByRank(alltimeKey, topN, -1),
          client.zremRangeByRank(dailyKey,   topN, -1),
          client.zremRangeByRank(weeklyKey,  topN, -1),
        ]);
      }

      const elapsed = Date.now() - tickStart;
      const sleepTime = tickIntervalMs - elapsed;
      if (sleepTime > 0) {
        await sleep(sleepTime);
      }
    }

    // Compute latency percentiles
    function computePercentiles(arr) {
      const sorted = [...arr].sort((a, b) => a - b);
      const p = (pct) => sorted[Math.floor(pct / 100 * sorted.length)] || 0;
      return { p50: p(50), p95: p(95), p99: p(99), max: sorted[sorted.length - 1] || 0, min: sorted[0] || 0, count: sorted.length };
    }

    console.log(`Worker ${workerId} complete. Ships: ${ships.length}, updates: ${totalUpdates}`);

    // Write load test results if this is part of a load test
    if (event.loadTestId && LOADTEST_TABLE) {
      await ddbClient.send(new PutCommand({
        TableName: LOADTEST_TABLE,
        Item: {
          testId: event.loadTestId,
          recordType: `worker-${workerId}`,
          workerId,
          shipCount: ships.length,
          totalUpdates,
          duration,
          tickInterval: tickIntervalMs,
          latencyMs: computePercentiles(latencies),
          opsPerSecond: Math.round(totalUpdates / duration),
          errors: 0,
          phase: event.phase !== undefined ? event.phase : null,
          completedAt: new Date().toISOString(),
        },
      }));
    }

    // Update DynamoDB profiles and sync lifetime stats to Valkey hash
    if (PROFILES_TABLE) {
      const now = new Date().toISOString();
      const DDB_BATCH = 25;
      for (let i = 0; i < ships.length; i += DDB_BATCH) {
        const chunk = ships.slice(i, i + DDB_BATCH);
        const ddbResults = await Promise.all(chunk.map(ship =>
          ddbClient.send(new UpdateCommand({
            TableName: PROFILES_TABLE,
            Key: { shipId: ship.shipId },
            UpdateExpression: 'SET lastActiveAt = :now ADD totalSimulations :one, lifetimeOreHauled :ore',
            ExpressionAttributeValues: {
              ':now': now,
              ':one': 1,
              ':ore': oreEarned[ship.shipId] || 0,
            },
            ReturnValues: 'ALL_NEW',
          })).catch(err => { console.warn(`DDB update failed for ${ship.shipId}:`, err.message); return null; })
        ));

        // Sync lifetime stats to Valkey hash for leaderboard enrichment
        const hashBatch = new Batch(false);
        for (let j = 0; j < chunk.length; j++) {
          const result = ddbResults[j];
          if (result && result.Attributes) {
            const attrs = result.Attributes;
            hashBatch.hset(`ship:${chunk[j].shipId}`, {
              shipName: attrs.shipName || chunk[j].shipName,
              pilotName: attrs.pilotName || chunk[j].pilotName,
              shipClass: attrs.shipClass || chunk[j].shipClass,
              totalSimulations: String(attrs.totalSimulations || 0),
              lifetimeOreHauled: String(attrs.lifetimeOreHauled || 0),
            });
          }
        }
        await client.exec(hashBatch, false);
      }
    }

    return {
      message: 'Simulation complete',
      workerId,
      shipsSimulated: ships.length,
      totalUpdates,
      updatePolicy,
      topN,
      profilesUpdated: PROFILES_TABLE ? ships.length : 0,
      keys: { alltime: alltimeKey, daily: dailyKey, weekly: weeklyKey },
    };
  } catch (err) {
    console.error('Unhandled error in worker handler:', err);
    return { message: 'Simulation failed', error: err.message };
  }
};
