export interface LeaderboardEntry {
  rank: number;
  shipId: string;
  shipName: string;
  pilotName: string;
  shipClass: string;
  score: number;
  totalSimulations?: number;
  lifetimeOreHauled?: number;
}

export type TimeWindow = 'alltime' | 'daily' | 'weekly';
export type UpdatePolicy = 'cumulative' | 'best';

export interface SimConfig {
  shipCount: number;
  duration: number;
  updatePolicy: UpdatePolicy;
  topN: number;
  chunkSize: number;
}

export interface PaginationInfo {
  offset: number;
  limit: number;
  count: number;
  total: number;
  hasMore: boolean;
}

export interface PaginatedLeaderboard {
  entries: LeaderboardEntry[];
  pagination: PaginationInfo;
}

export interface LeaderboardStats {
  alltime: { shipCount: number; key: string };
  daily: { shipCount: number; key: string };
  weekly: { shipCount: number; key: string };
}

export interface StreamEvent {
  id: string;
  type: string;
  workerId?: string;
  ships?: string;
  tick?: string;
  opsThisTick?: string;
  duration?: string;
  updatePolicy?: string;
  totalUpdates?: string;
  p50?: string;
}

export interface EventsResponse {
  events: StreamEvent[];
  count: number;
  streamLength: number;
  lastId: string;
}

export interface LeaderboardWindows {
  alltime: boolean;
  daily: string[];
  weekly: string[];
}
