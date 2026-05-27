import React, { useState } from 'react';
import { SimConfig, UpdatePolicy } from '../types';

interface SimulationControlsProps {
  onLaunch: (config: SimConfig) => void;
  onReset: () => void;
  isRunning: boolean;
  lastLaunchTime: Date | null;
}

const SHIP_COUNT_OPTIONS = [
  { label: '10', value: 10 },
  { label: '50', value: 50 },
  { label: '100', value: 100 },
  { label: '500', value: 500 },
  { label: '1K', value: 1000 },
  { label: '2K', value: 2000 },
];

const DURATION_OPTIONS = [
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: '120s', value: 120 },
];

const TOP_N_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: 'Top 10', value: 10 },
  { label: 'Top 50', value: 50 },
  { label: 'Top 100', value: 100 },
  { label: 'Top 500', value: 500 },
];

const CHUNK_SIZE_OPTIONS = [
  { label: '25 ships/worker', value: 25 },
  { label: '50 ships/worker', value: 50 },
  { label: '100 ships/worker', value: 100 },
  { label: '200 ships/worker', value: 200 },
];

const SimulationControls: React.FC<SimulationControlsProps> = ({
  onLaunch,
  onReset,
  isRunning,
  lastLaunchTime,
}) => {
  const [shipCount, setShipCount] = useState<number>(100);
  const [duration, setDuration] = useState<number>(60);
  const [updatePolicy, setUpdatePolicy] = useState<UpdatePolicy>('cumulative');
  const [topN, setTopN] = useState<number>(0);
  const [chunkSize, setChunkSize] = useState<number>(50);

  const handleLaunch = () => {
    onLaunch({ shipCount, duration, updatePolicy, topN, chunkSize });
  };

  const formatLastLaunch = (date: Date): string => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="controls-panel">
      <div className="controls-row">
        {/* Ship Count Selector — dropdown for larger scale */}
        <div className="control-group">
          <label className="control-label">Fleet Size</label>
          <select
            className="control-select"
            value={shipCount}
            onChange={(e) => setShipCount(Number(e.target.value))}
            disabled={isRunning}
          >
            {SHIP_COUNT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Duration Selector */}
        <div className="control-group">
          <label className="control-label">Duration</label>
          <div className="segmented-control">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`segmented-btn${duration === opt.value ? ' active' : ''}`}
                onClick={() => setDuration(opt.value)}
                disabled={isRunning}
                type="button"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="control-group control-actions">
          <button
            className="btn btn-launch"
            onClick={handleLaunch}
            disabled={isRunning}
            type="button"
          >
            {isRunning ? (
              <>
                <span className="btn-spinner" />
                Fleet Active…
              </>
            ) : (
              <>⚡ Launch Fleet</>
            )}
          </button>
          <button
            className="btn btn-reset"
            onClick={onReset}
            type="button"
          >
            ↺ Reset Board
          </button>
        </div>
      </div>

      {/* Second row: scoring policy + top-N cap */}
      <div className="controls-row controls-row-secondary">
        {/* Update Policy Toggle */}
        <div className="control-group">
          <label className="control-label">
            Scoring Mode
            <span
              className="control-tooltip"
              title="Cumulative: ships accumulate total ore across all hauls. Best: only the highest single haul score is kept."
            >
              ?
            </span>
          </label>
          <div className="segmented-control">
            <button
              className={`segmented-btn${updatePolicy === 'cumulative' ? ' active' : ''}`}
              onClick={() => setUpdatePolicy('cumulative')}
              disabled={isRunning}
              type="button"
              title="Cumulative: ships accumulate total ore across all hauls."
            >
              Cumulative Haul
            </button>
            <button
              className={`segmented-btn${updatePolicy === 'best' ? ' active' : ''}`}
              onClick={() => setUpdatePolicy('best')}
              disabled={isRunning}
              type="button"
              title="Best: only the highest single haul score is kept."
            >
              Best Single Haul
            </button>
          </div>
        </div>

        {/* Top-N Cap */}
        <div className="control-group">
          <label className="control-label">Leaderboard Cap</label>
          <select
            className="control-select"
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
            disabled={isRunning}
          >
            {TOP_N_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Chunk Size (workers) */}
        <div className="control-group">
          <label className="control-label">
            Worker Size
            <span
              className="control-tooltip"
              title="Ships per worker Lambda. Smaller chunks = more concurrent workers hitting Valkey. E.g. 1000 ships ÷ 50/worker = 20 parallel workers."
            >
              ?
            </span>
          </label>
          <select
            className="control-select"
            value={chunkSize}
            onChange={(e) => setChunkSize(Number(e.target.value))}
            disabled={isRunning}
          >
            {CHUNK_SIZE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Status Area */}
      <div className="status-bar">
        {isRunning ? (
          <span className="status-active">
            <span className="status-dot" />
            Simulation active — leaderboard updates every 2s
          </span>
        ) : lastLaunchTime ? (
          <span className="status-idle">
            Last fleet launched at {formatLastLaunch(lastLaunchTime)} — updates every 5s
          </span>
        ) : (
          <span className="status-idle">Standing by — launch a fleet to begin</span>
        )}
      </div>
    </div>
  );
};

export default SimulationControls;
