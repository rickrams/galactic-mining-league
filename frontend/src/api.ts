import { LeaderboardEntry, LeaderboardStats, LeaderboardWindows, PaginatedLeaderboard, SimConfig, TimeWindow } from './types';

let apiBaseUrl: string = process.env.REACT_APP_API_URL || '';

export function setApiBaseUrl(url: string): void {
  apiBaseUrl = url.replace(/\/$/, '');
}

export async function getLeaderboard(
  window?: TimeWindow,
  dateOrWeek?: string,
  offset?: number,
  limit?: number,
  shipClass?: string,
): Promise<PaginatedLeaderboard> {
  const params = new URLSearchParams();
  if (window) params.set('window', window);
  if (window === 'daily' && dateOrWeek) params.set('date', dateOrWeek);
  if (window === 'weekly' && dateOrWeek) params.set('week', dateOrWeek);
  if (offset !== undefined) params.set('offset', String(offset));
  if (limit !== undefined) params.set('limit', String(limit));
  if (shipClass) params.set('shipClass', shipClass);
  const url = `${apiBaseUrl}/leaderboard?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch leaderboard: ${response.status}`);
  const data = await response.json();
  // Handle both old (array) and new (paginated) response shapes
  if (Array.isArray(data)) {
    return { entries: data, pagination: { offset: 0, limit: data.length, count: data.length, total: data.length, hasMore: false } };
  }
  return data;
}

export async function getWindows(): Promise<LeaderboardWindows> {
  const response = await fetch(`${apiBaseUrl}/leaderboard/windows`);
  if (!response.ok) {
    throw new Error(`Failed to fetch leaderboard windows: ${response.status}`);
  }
  return response.json();
}

export async function getStats(): Promise<LeaderboardStats> {
  const response = await fetch(`${apiBaseUrl}/leaderboard/stats`);
  if (!response.ok) {
    throw new Error(`Failed to fetch leaderboard stats: ${response.status}`);
  }
  return response.json();
}

export async function getAboveThreshold(
  threshold: number,
  window?: TimeWindow,
  dateOrWeek?: string,
): Promise<{ count: number; entries: LeaderboardEntry[] }> {
  const params = new URLSearchParams();
  if (window) params.set('window', window);
  if (window === 'daily' && dateOrWeek) params.set('date', dateOrWeek);
  if (window === 'weekly' && dateOrWeek) params.set('week', dateOrWeek);
  const url = `${apiBaseUrl}/leaderboard/above/${threshold}${params.toString() ? '?' + params.toString() : ''}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch threshold filter: ${response.status}`);
  }
  return response.json();
}

export async function applyTopN(topN: number, window: TimeWindow): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/leaderboard/topn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topN, window }),
  });
  if (!response.ok) {
    throw new Error(`Failed to apply top-N: ${response.status}`);
  }
}

export async function startSimulation(config: SimConfig): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/simulation/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shipCount: config.shipCount,
      duration: config.duration,
      updatePolicy: config.updatePolicy,
      topN: config.topN,
      chunkSize: config.chunkSize,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to start simulation: ${response.status}`);
  }
}

export async function resetLeaderboard(): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/leaderboard`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`Failed to reset leaderboard: ${response.status}`);
  }
}
