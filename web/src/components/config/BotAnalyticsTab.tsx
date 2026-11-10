import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import type { Bot } from '@shared/types';
import { configApi, type BotAnalytics } from '../../lib/configApi';
import { niceTicks } from './UsageSection';
import { Segmented } from './ui';
import '../../styles/analytics.css';

/**
 * A Bot's analytics (Bot settings → Analytics): messages per day and an estimate of the time it saved.
 * Designed in Paper (Swarm — Mobile → Composer & Analytics → Bot settings · Analytics).
 */
type Range = '7d' | '30d' | '90d';
const RANGES: { value: Range; label: string }[] = [{ value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' }];
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const span = (a: string, b: string) => {
  const [x, y] = [new Date(`${a}T00:00:00Z`), new Date(`${b}T00:00:00Z`)];
  return x.getUTCMonth() === y.getUTCMonth() ? `${dayLabel(a)} – ${y.getUTCDate()}` : `${dayLabel(a)} – ${dayLabel(b)}`;
};
/** 0.5 → "30 min", 70 → "70 h", 7.5 → "7.5 h". */
export const fmtHours = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${Math.round((min / 60) * 10) / 10} h`);

export function BotAnalyticsTab({ bot }: { bot: Bot }) {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<BotAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  useEffect(() => {
    let alive = true;
    configApi.botAnalytics(bot.id, range).then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [bot.id, range]);

  if (error) return <div className="cfg-page"><div className="cfg-error">{error}</div></div>;
  if (!data) return <div className="cfg-page"><div className="cfg-empty cfg-empty--flat">Loading…</div></div>;
  const days = data.days;
  const hoursTotal = data.totals.minutesSaved / 60;
  const r = data.rates;
  const method = `Estimated from what ${bot.name} did: about ${r.pageRead} minutes per page it read, ${r.webSearch} per web search or app action, ${r.command} per command, ${r.computerStep * 60} seconds per computer step, and writing at ${r.wordsPerMinute} words a minute.`;
  const maxBreak = Math.max(...data.breakdown.map((b) => b.minutes), 1);

  return (
    <div className="cfg-page an-page">
      <div className="an-range">
        <span className="an-range__span">{span(days[0].day, days[days.length - 1].day)}</span>
        <Segmented label="Period" value={range} options={RANGES} onChange={setRange} />
      </div>
      <div className="an-cards">
        <section className="an-card" aria-label="Messages">
          <div className="an-card__label">Messages</div>
          <div className="an-card__value">{data.totals.messages.toLocaleString('en-US')}</div>
          <BarChart days={days} />
        </section>
        <section className="an-card is-saved" aria-label="Hours saved">
          <div className="an-card__label">
            Hours saved
            <button type="button" className="an-info" aria-label="How hours saved is estimated" aria-expanded={showInfo} onClick={() => setShowInfo(!showInfo)}><Info size={14} strokeWidth={1.75} /></button>
          </div>
          {showInfo && <div className="an-info__pop" role="note">{method}</div>}
          <div className="an-card__value">{hoursTotal < 1 ? Math.round(data.totals.minutesSaved) : Math.round(hoursTotal * 10) / 10}<span className="an-card__unit">{hoursTotal < 1 ? 'minutes' : 'hours'}</span></div>
          <CumulativeChart days={days} />
        </section>
      </div>
      <details className="usage-table an-table">
        <summary>Show as a table</summary>
        <table>
          <thead><tr><th>Day (UTC)</th><th>Messages</th><th>Time saved</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.day}><td>{dayLabel(d.day)}</td><td>{d.messages}</td><td>{d.minutesSaved ? fmtHours(d.minutesSaved) : '—'}</td></tr>)}</tbody>
        </table>
      </details>
      {data.breakdown.length > 0 && (
        <section className="an-where" aria-label="Where the time went">
          <div className="an-where__head"><span>Where the time went</span><span className="an-where__note">Estimated</span></div>
          <ul>
            {data.breakdown.map((b) => (
              <li key={b.key} className="an-where__row">
                <span className="an-where__label">{b.label}</span>
                <span className="an-where__bar" aria-hidden><span style={{ width: `${(b.minutes / maxBreak) * 100}%` }} /></span>
                <span className="an-where__figure">{fmtHours(b.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="an-method">{method}</p>
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(300);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Shared frame: grid, y values on the right, three date labels, a per-day hover/tap readout. */
function Frame({ days, ticks, top, children, readout, onPick, pick }: {
  days: BotAnalytics['days']; ticks: number[]; top: number; children: (w: number) => ReactNode; readout: (i: number) => string; onPick: (i: number | null) => void; pick: number | null;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = 150;
  const at = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPick(Math.min(days.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * days.length))));
  };
  const mid = Math.floor((days.length - 1) / 2);
  return (
    <div className="an-chart">
      <div className="an-chart__row">
        <div ref={ref} className="an-plot" style={{ height: H }} onPointerDown={at} onPointerMove={at} onPointerLeave={(e) => { if (e.pointerType === 'mouse') onPick(null); }} role="img" aria-label={readout(days.length - 1)}>
          {ticks.map((t) => <div key={t} className="an-grid" style={{ bottom: `${(t / top) * 100}%` }} />)}
          {children(w)}
          {pick !== null && <div className="an-tip" style={{ left: `${((pick + 0.5) / days.length) * 100}%`, transform: `translateX(${pick < days.length * 0.25 ? '0%' : pick > days.length * 0.75 ? '-100%' : '-50%'})` }}>{readout(pick)}</div>}
        </div>
        <div className="an-axis" style={{ height: H }} aria-hidden>{ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{Math.round(t * 10) / 10}</span>)}</div>
      </div>
      <div className="an-dates" aria-hidden><span>{dayLabel(days[0].day)}</span><span>{dayLabel(days[mid].day)}</span><span>{dayLabel(days[days.length - 1].day)}</span></div>
    </div>
  );
}

function BarChart({ days }: { days: BotAnalytics['days'] }) {
  const [pick, setPick] = useState<number | null>(null);
  const ticks = niceTicks(Math.max(...days.map((d) => d.messages), 1));
  const top = ticks[ticks.length - 1] || 1;
  return (
    <Frame days={days} ticks={ticks} top={top} pick={pick} onPick={setPick}
      readout={(i) => `${dayLabel(days[i].day)}: ${days[i].messages} message${days[i].messages === 1 ? '' : 's'}`}>
      {() => (
        <div className="an-bars">
          {days.map((d, i) => (
            <div key={d.day} className={`an-bar-slot${pick !== null && pick !== i ? ' is-dim' : ''}`}>
              {d.messages > 0 && <div className="an-bar" style={{ height: `${(d.messages / top) * 100}%` }} />}
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

function CumulativeChart({ days }: { days: BotAnalytics['days'] }) {
  const [pick, setPick] = useState<number | null>(null);
  const cum = useMemo(() => days.reduce<number[]>((a, d) => [...a, (a[a.length - 1] ?? 0) + d.minutesSaved / 60], []), [days]);
  const ticks = niceTicks(Math.max(cum[cum.length - 1] ?? 0, 1));
  const top = ticks[ticks.length - 1] || 1;
  const H = 150;
  return (
    <Frame days={days} ticks={ticks} top={top} pick={pick} onPick={setPick}
      readout={(i) => `${dayLabel(days[i].day)}: ${fmtHours(days[i].minutesSaved)} that day · ${fmtHours(cum[i] * 60)} so far`}>
      {(w) => {
        const x = (i: number) => ((i + 0.5) / days.length) * w; // slot centres, like the bars and the readout
        const y = (v: number) => H - (v / top) * H;
        const line = cum.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
        return (
          <svg className="an-line" width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden>
            <path d={`${line} L${x(cum.length - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`} className="an-line__area" />
            <path d={line} className="an-line__stroke" />
            {pick !== null && <><line x1={x(pick)} x2={x(pick)} y1={0} y2={H} className="an-line__cross" /><circle cx={x(pick)} cy={y(cum[pick])} r={4} className="an-line__dot" /></>}
          </svg>
        );
      }}
    </Frame>
  );
}
