import React, { useEffect, useRef, useState } from 'react';
import { StreamEvent } from '../types';
import { getEvents } from '../api';

interface EventFeedProps {
  isRunning: boolean;
  configLoaded: boolean;
}

function formatEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'sim_start':
      return `Worker ${event.workerId} started — ${event.ships} ships, ${event.duration}s, ${event.updatePolicy}`;
    case 'sim_complete':
      return `Worker ${event.workerId} done — ${event.ships} ships, ${event.totalUpdates} ops, p50=${event.p50}ms`;
    case 'tick':
      return `Worker ${event.workerId} tick ${event.tick} — ${event.opsThisTick} ops`;
    default:
      return `${event.type}: worker ${event.workerId}`;
  }
}

function eventTypeClass(type: string): string {
  switch (type) {
    case 'sim_start': return 'event-start';
    case 'sim_complete': return 'event-complete';
    case 'tick': return 'event-tick';
    default: return '';
  }
}

const EventFeed: React.FC<EventFeedProps> = ({ isRunning, configLoaded }) => {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [streamLength, setStreamLength] = useState(0);
  const lastIdRef = useRef<string>('0-0');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!configLoaded) return;

    const poll = async () => {
      try {
        const data = await getEvents(lastIdRef.current);
        if (data.events.length > 0) {
          lastIdRef.current = data.lastId;
          setEvents((prev) => [...data.events, ...prev].slice(0, 50));
        }
        setStreamLength(data.streamLength);
      } catch { /* ignore */ }
      timerRef.current = setTimeout(poll, isRunning ? 1000 : 3000);
    };

    poll();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [isRunning, configLoaded]);

  return (
    <div className="event-feed">
      <div className="event-feed-header">
        <h3 className="event-feed-title">Event Stream</h3>
        <span className="event-feed-badge">XADD / XRANGE — {streamLength} entries</span>
      </div>
      <div className="event-feed-list">
        {events.length === 0 ? (
          <div className="event-feed-empty">No events yet — launch a simulation</div>
        ) : (
          events.map((ev) => (
            <div key={ev.id} className={`event-item ${eventTypeClass(ev.type)}`}>
              <span className="event-id">{ev.id}</span>
              <span className="event-text">{formatEvent(ev)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default EventFeed;
