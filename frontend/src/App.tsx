import React, { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import Leaderboard from './components/Leaderboard';
import SimulationControls from './components/SimulationControls';
import { LeaderboardEntry, LeaderboardStats, LeaderboardWindows, PaginationInfo, SimConfig, TimeWindow } from './types';
import {
  setApiBaseUrl,
  getLeaderboard,
  getStats,
  getWindows,
  getAboveThreshold,
  startSimulation,
  resetLeaderboard,
} from './api';

const POLL_INTERVAL_RUNNING = 2000;
const POLL_INTERVAL_IDLE = 5000;

const WINDOW_LABELS: Record<TimeWindow, string> = {
  alltime: 'All Time',
  daily: 'Daily',
  weekly: 'Weekly',
};

const PAGE_SIZE = 50;

function App() {
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // Leaderboard entries (either filtered or full)
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Pagination
  const [page, setPage] = useState(0);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const pageRef = useRef(0);
  pageRef.current = page;

  // Stats
  const [stats, setStats] = useState<LeaderboardStats | null>(null);

  // Time window
  const [activeWindow, setActiveWindow] = useState<TimeWindow>('alltime');
  const activeWindowRef = useRef<TimeWindow>('alltime');
  activeWindowRef.current = activeWindow;

  // Date/week selector for daily/weekly windows
  const [windows, setWindows] = useState<LeaderboardWindows | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedWeek, setSelectedWeek] = useState<string>('');
  const selectedDateRef = useRef<string>('');
  const selectedWeekRef = useRef<string>('');
  selectedDateRef.current = selectedDate;
  selectedWeekRef.current = selectedWeek;

  // Ship class filter
  const [classFilter, setClassFilter] = useState<string>('');
  const classFilterRef = useRef<string>('');
  classFilterRef.current = classFilter;

  // Threshold filter
  const [thresholdInput, setThresholdInput] = useState<string>('');
  const [activeThreshold, setActiveThreshold] = useState<number | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [isFiltering, setIsFiltering] = useState(false);

  // Simulation state
  const [isRunning, setIsRunning] = useState(false);
  const [lastLaunchTime, setLastLaunchTime] = useState<Date | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;

  const activeThresholdRef = useRef<number | null>(null);
  activeThresholdRef.current = activeThreshold;

  // ---- Load config.json at startup ----
  useEffect(() => {
    let cancelled = false;
    fetch('/config.json')
      .then((res) => {
        if (!res.ok) throw new Error(`config.json not found (${res.status})`);
        return res.json();
      })
      .then((cfg: { apiUrl?: string }) => {
        if (cancelled) return;
        if (cfg.apiUrl) {
          setApiBaseUrl(cfg.apiUrl);
        }
        setConfigLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Fall back gracefully — use whatever is baked in via env var
        setConfigLoaded(true);
        // Only show an error if there's also no env-var fallback
        if (!process.env.REACT_APP_API_URL) {
          setConfigError('config.json not found — API URL may not be configured.');
        }
      });
    return () => { cancelled = true; };
  }, []);

  // ---- Fetch board + stats + windows together ----
  const fetchData = useCallback(async () => {
    const window = activeWindowRef.current;
    const threshold = activeThresholdRef.current;
    const currentPage = pageRef.current;
    const dateOrWeek = window === 'daily'
      ? selectedDateRef.current || undefined
      : window === 'weekly'
        ? selectedWeekRef.current || undefined
        : undefined;

    try {
      const [boardData, statsData, windowsData] = await Promise.all([
        threshold !== null
          ? getAboveThreshold(threshold, window, dateOrWeek, classFilterRef.current || undefined).then((r) => {
              setFilteredCount(r.count);
              setPagination(null);
              return r.entries;
            })
          : getLeaderboard(window, dateOrWeek, currentPage * PAGE_SIZE, PAGE_SIZE, classFilterRef.current || undefined).then((r) => {
              setPagination(r.pagination);
              return r.entries;
            }),
        getStats(),
        getWindows(),
      ]);
      setEntries(boardData);
      setStats(statsData);
      setWindows(windowsData);
      setFetchError(null);
    } catch (err: any) {
      setFetchError(err.message ?? 'Failed to fetch leaderboard');
    } finally {
      setIsLoadingEntries(false);
    }
  }, []);

  // ---- Polling ----
  const schedulePoll = useCallback((delay: number) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(async () => {
      await fetchData();
      schedulePoll(isRunningRef.current ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    }, delay);
  }, [fetchData]);

  useEffect(() => {
    if (!configLoaded) return;

    setIsLoadingEntries(true);
    fetchData().finally(() => {
      schedulePoll(isRunning ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    });

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded]);

  // Re-schedule with correct interval when running state changes
  useEffect(() => {
    if (!configLoaded) return;
    schedulePoll(isRunning ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // When page changes, re-fetch
  useEffect(() => {
    if (!configLoaded) return;
    setIsLoadingEntries(true);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    fetchData().finally(() => {
      schedulePoll(isRunningRef.current ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // When active window changes: clear filter and date/week, reset page, re-fetch
  const handleWindowChange = useCallback((window: TimeWindow) => {
    setActiveWindow(window);
    activeWindowRef.current = window;
    setActiveThreshold(null);
    activeThresholdRef.current = null;
    setFilteredCount(null);
    setThresholdInput('');
    setFilterError(null);
    setSelectedDate('');
    setSelectedWeek('');
    selectedDateRef.current = '';
    selectedWeekRef.current = '';
    setClassFilter('');
    classFilterRef.current = '';
    setPage(0);
    pageRef.current = 0;

    setIsLoadingEntries(true);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    fetchData().finally(() => {
      schedulePoll(isRunningRef.current ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    });
  }, [fetchData, schedulePoll]);

  // When ship class filter changes, reset page and re-fetch
  const handleClassFilterChange = useCallback((value: string) => {
    setClassFilter(value);
    classFilterRef.current = value;
    setPage(0);
    pageRef.current = 0;
    setIsLoadingEntries(true);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    fetchData().finally(() => {
      schedulePoll(isRunningRef.current ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    });
  }, [fetchData, schedulePoll]);

  // When date/week selector changes, reset page and re-fetch with new key
  const handleDateOrWeekChange = useCallback((value: string) => {
    if (activeWindowRef.current === 'daily') {
      setSelectedDate(value);
      selectedDateRef.current = value;
    } else {
      setSelectedWeek(value);
      selectedWeekRef.current = value;
    }
    setPage(0);
    pageRef.current = 0;
    setIsLoadingEntries(true);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    fetchData().finally(() => {
      schedulePoll(isRunningRef.current ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    });
  }, [fetchData, schedulePoll]);

  // ---- Threshold filter ----
  const handleFilter = useCallback(async () => {
    const parsed = parseInt(thresholdInput, 10);
    if (isNaN(parsed) || parsed < 0) {
      setFilterError('Enter a valid non-negative number');
      return;
    }
    setFilterError(null);
    setIsFiltering(true);
    setPage(0);
    pageRef.current = 0;
    try {
      const dateOrWeek = activeWindowRef.current === 'daily' ? selectedDateRef.current || undefined : activeWindowRef.current === 'weekly' ? selectedWeekRef.current || undefined : undefined;
      const result = await getAboveThreshold(parsed, activeWindowRef.current, dateOrWeek, classFilterRef.current || undefined);
      setEntries(result.entries);
      setFilteredCount(result.count);
      setPagination(null);
      setActiveThreshold(parsed);
      activeThresholdRef.current = parsed;
    } catch (err: any) {
      setFilterError(err.message ?? 'Filter failed');
    } finally {
      setIsFiltering(false);
    }
  }, [thresholdInput]);

  const handleClearFilter = useCallback(() => {
    setActiveThreshold(null);
    activeThresholdRef.current = null;
    setFilteredCount(null);
    setThresholdInput('');
    setFilterError(null);
    setPage(0);
    pageRef.current = 0;

    setIsLoadingEntries(true);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    fetchData().finally(() => {
      schedulePoll(isRunningRef.current ? POLL_INTERVAL_RUNNING : POLL_INTERVAL_IDLE);
    });
  }, [fetchData, schedulePoll]);

  // ---- Handlers ----
  const handleLaunch = useCallback(async (config: SimConfig) => {
    setActionError(null);
    try {
      await startSimulation(config);
      setIsRunning(true);
      setLastLaunchTime(new Date());

      // After the simulation duration, flip back to idle polling
      setTimeout(() => {
        setIsRunning(false);
      }, config.duration * 1000 + 2000); // +2s buffer for final updates
    } catch (err: any) {
      setActionError(err.message ?? 'Failed to start simulation');
    }
  }, []);

  const handleReset = useCallback(async () => {
    setActionError(null);
    try {
      await resetLeaderboard();
      setEntries([]);
      setIsRunning(false);
      setActiveThreshold(null);
      activeThresholdRef.current = null;
      setFilteredCount(null);
      setThresholdInput('');
      setFilterError(null);
      setPage(0);
      pageRef.current = 0;
      setPagination(null);
    } catch (err: any) {
      setActionError(err.message ?? 'Failed to reset leaderboard');
    }
  }, []);

  // ---- Render ----
  if (!configLoaded) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="header-title">⚡ Galactic Mining League</h1>
          <p className="header-subtitle">Live Ore Haul Leaderboard</p>
        </header>
        <div className="config-loading">
          <div className="spinner" />
          <p>Initializing navigation systems…</p>
        </div>
      </div>
    );
  }

  const displayedEntries = entries;
  const totalCount = activeThreshold !== null
    ? filteredCount ?? displayedEntries.length
    : pagination
      ? pagination.total
      : displayedEntries.length;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="header-title">⚡ Galactic Mining League</h1>
        <p className="header-subtitle">Live Ore Haul Leaderboard</p>
      </header>

      <SimulationControls
        onLaunch={handleLaunch}
        onReset={handleReset}
        isRunning={isRunning}
        lastLaunchTime={lastLaunchTime}
      />

      {configError && (
        <div className="error-banner">
          <span>⚠</span>
          {configError}
        </div>
      )}

      {actionError && (
        <div className="error-banner">
          <span>⚠</span>
          {actionError}
        </div>
      )}

      {fetchError && (
        <div className="error-banner">
          <span>⚠</span>
          {fetchError}
        </div>
      )}

      {/* Time Window Tabs */}
      <div className="window-tabs">
        {(['alltime', 'daily', 'weekly'] as TimeWindow[]).map((w) => {
          const count = stats ? stats[w].shipCount : null;
          return (
            <button
              key={w}
              className={`window-tab${activeWindow === w ? ' window-tab-active' : ''}`}
              onClick={() => handleWindowChange(w)}
              type="button"
            >
              {WINDOW_LABELS[w]}
              {count !== null && (
                <span className="tab-badge">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Date/Week Selector */}
      {activeWindow === 'daily' && windows && windows.daily.length > 0 && (
        <div className="date-selector">
          <label className="date-selector-label">Date:</label>
          <select
            className="control-select"
            value={selectedDate}
            onChange={(e) => handleDateOrWeekChange(e.target.value)}
          >
            <option value="">Today</option>
            {windows.daily.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      )}
      {activeWindow === 'weekly' && windows && windows.weekly.length > 0 && (
        <div className="date-selector">
          <label className="date-selector-label">Week:</label>
          <select
            className="control-select"
            value={selectedWeek}
            onChange={(e) => handleDateOrWeekChange(e.target.value)}
          >
            <option value="">Current Week</option>
            {windows.weekly.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
      )}

      {/* Stats Bar */}
      {stats && (
        <div className="stats-bar">
          <div className="stats-card">
            <span className="stats-card-label">Ships Ranked</span>
            <span className="stats-card-value">{stats.alltime.shipCount.toLocaleString()}</span>
            <span className="stats-card-annotation">all time ZCARD</span>
          </div>
          <div className="stats-card">
            <span className="stats-card-label">Scored Today</span>
            <span className="stats-card-value">{stats.daily.shipCount.toLocaleString()}</span>
            <span className="stats-card-annotation">daily ZCARD</span>
          </div>
          <div className="stats-card">
            <span className="stats-card-label">Scored This Week</span>
            <span className="stats-card-value">{stats.weekly.shipCount.toLocaleString()}</span>
            <span className="stats-card-annotation">weekly ZCARD</span>
          </div>
        </div>
      )}

      {/* Filters Row */}
      <div className="threshold-filter">
        <select
          className="control-select"
          value={classFilter}
          onChange={(e) => handleClassFilterChange(e.target.value)}
        >
          <option value="">All Classes</option>
          <option value="Excavator">Excavator</option>
          <option value="Hauler">Hauler</option>
          <option value="Dreadnought">Dreadnought</option>
          <option value="Corvette">Corvette</option>
          <option value="Scout">Scout</option>
        </select>
        <input
          className="threshold-input"
          type="number"
          min={0}
          placeholder="Min score threshold"
          value={thresholdInput}
          onChange={(e) => setThresholdInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleFilter(); }}
          disabled={isFiltering}
        />
        <button
          className="btn btn-filter"
          onClick={handleFilter}
          disabled={isFiltering || thresholdInput === ''}
          type="button"
        >
          {isFiltering ? <><span className="btn-spinner" />Filtering…</> : 'Filter'}
        </button>
        {activeThreshold !== null && (
          <button
            className="btn btn-filter-clear"
            onClick={handleClearFilter}
            type="button"
          >
            Clear
          </button>
        )}
        {activeThreshold !== null && filteredCount !== null && (
          <span className="filter-badge">
            Showing {filteredCount} ship{filteredCount !== 1 ? 's' : ''} above {activeThreshold.toLocaleString()} ore
          </span>
        )}
        {filterError && (
          <span className="filter-error">{filterError}</span>
        )}
      </div>

      <div className="section-header">
        <h2 className="section-title">Fleet Rankings — {WINDOW_LABELS[activeWindow]}</h2>
        {totalCount > 0 && (
          <span className="entry-count">{totalCount.toLocaleString()} ship{totalCount !== 1 ? 's' : ''} logged</span>
        )}
      </div>

      <Leaderboard entries={displayedEntries} isLoading={isLoadingEntries} />

      {pagination && pagination.total > PAGE_SIZE && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span className="pagination-info">
            {pagination.offset + 1}–{pagination.offset + pagination.count} of {pagination.total.toLocaleString()}
          </span>
          <button disabled={!pagination.hasMore} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

export default App;
