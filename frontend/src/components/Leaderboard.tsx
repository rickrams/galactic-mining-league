import React from 'react';
import { LeaderboardEntry } from '../types';

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  isLoading: boolean;
}

const CLASS_BADGE_COLORS: Record<string, string> = {
  Excavator: '#ff8c00',
  Hauler: '#ffd700',
  Corvette: '#4a9eff',
  Scout: '#00c853',
  Dreadnought: '#9c27b0',
};

function getClassBadgeStyle(shipClass: string): React.CSSProperties {
  const color = CLASS_BADGE_COLORS[shipClass] ?? '#888';
  return {
    backgroundColor: `${color}22`,
    color,
    border: `1px solid ${color}66`,
    borderRadius: '12px',
    padding: '2px 10px',
    fontSize: '0.78rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  };
}

function getRankDisplay(rank: number): React.ReactNode {
  if (rank === 1) return <span className="rank-medal">🥇</span>;
  if (rank === 2) return <span className="rank-medal">🥈</span>;
  if (rank === 3) return <span className="rank-medal">🥉</span>;
  return <span className="rank-number">{rank}</span>;
}

function formatScore(score: number): string {
  return score.toLocaleString();
}

const Leaderboard: React.FC<LeaderboardProps> = ({ entries, isLoading }) => {
  const topScore = entries.length > 0 ? entries[0].score : 1;

  if (isLoading && entries.length === 0) {
    return (
      <div className="leaderboard-empty">
        <div className="spinner" />
        <p>Scanning sector for ore hauls…</p>
      </div>
    );
  }

  if (!isLoading && entries.length === 0) {
    return (
      <div className="leaderboard-empty">
        <div className="empty-icon">🚀</div>
        <p>No ships logged yet.</p>
        <p className="empty-sub">Launch a fleet to start tracking ore hauls.</p>
      </div>
    );
  }

  return (
    <div className="leaderboard-wrapper">
      {isLoading && <div className="leaderboard-refresh-indicator" />}
      <table className="leaderboard-table">
        <thead>
          <tr>
            <th className="col-rank">Rank</th>
            <th className="col-ship">Ship</th>
            <th className="col-pilot">Pilot</th>
            <th className="col-class">Class</th>
            <th className="col-score">Ore Hauled</th>
            <th className="col-lifetime">Lifetime</th>
            <th className="col-sims">Sims</th>
            <th className="col-bar">Performance</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const barPct = topScore > 0 ? Math.max((entry.score / topScore) * 100, 2) : 0;
            const isTop = entry.rank <= 3;
            return (
              <tr
                key={entry.shipId}
                className={`leaderboard-row${isTop ? ' top-row' : ''}`}
              >
                <td className="col-rank">{getRankDisplay(entry.rank)}</td>
                <td className="col-ship">
                  <span className="ship-name">{entry.shipName}</span>
                </td>
                <td className="col-pilot">{entry.pilotName}</td>
                <td className="col-class">
                  <span style={getClassBadgeStyle(entry.shipClass)}>
                    {entry.shipClass}
                  </span>
                </td>
                <td className="col-score">
                  <span className="score-value">{formatScore(entry.score)}</span>
                  <span className="score-unit"> t</span>
                </td>
                <td className="col-lifetime">
                  <span className="score-value">{entry.lifetimeOreHauled ? formatScore(entry.lifetimeOreHauled) : '—'}</span>
                </td>
                <td className="col-sims">
                  <span className="score-value">{entry.totalSimulations || '—'}</span>
                </td>
                <td className="col-bar">
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default Leaderboard;
