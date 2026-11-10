import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { useStore } from '../../store';
import { configApi, type ProviderUsage, type UsageRange, type UsageReport, type UsageRow } from '../../lib/configApi';
import '../../styles/usage.css';

/**
 * Settings → Usage: what the Bots' AI use costs, from what the providers report per request.
 * Everyone sees their own usage (and the free plan's daily allowance); the server's owner can
 * switch to everyone and sees the provider account (BYOK) itself.
 */

const RANGES: { value: UsageRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'month', label: 'This month' },
];

// ---------- formatting ----------

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  const a = Math.abs(v);
  if (a < 0.01) return `$${v.toFixed(4)}`;
  if (a < 1000) return `$${v.toFixed(2)}`;
  return `$${compact(v)}`;
}

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a < 10_000) return Math.round(v).toLocaleString('en-US');
  if (a < 1_000_000) return `${(v / 1000).toFixed(a < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  if (a < 1_000_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${(v / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${compact(n)} ${n === 1 ? one : many}`;
const dayLong = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const inHours = (t: number) => {
  const h = Math.max(0, Math.round((t - Date.now()) / 3_600_000));
  return h < 1 ? 'in under an hour' : `in ${h} h`;
};

/** Clean axis ticks from 0 up past `max` (1 / 2 / 2.5 / 5 × 10^n steps, at most 5 ticks). */
function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const p = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s * 4 >= max) ?? 10 * p;
  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, i) => i * step);
}

// ---------- pieces ----------

/** Title, with whose usage (owners) beside it. Phones swap the description for the dates covered. */
function PageHead({ span, scope }: { span: string | null; scope?: ReactNode }) {
  return (
    <div className="app-settings__head usage-head">
      <div className="usage-head__text">
        <h1>Usage</h1>
        <p className="usage-head__desc">What your Bots’ AI use costs: tokens, requests and dollars, as each provider reports them per request.</p>
        {span && <p className="usage-head__span">{span}</p>}
      </div>
      {scope}
    </div>
  );
}

/** The headline: what the period cost, and how it splits between AI and the computer. */
function Hero({ ai, computer, days, sub }: { ai: number; computer: number | null; days: number; sub?: string }) {
  const total = ai + (computer ?? 0);
  const parts = computer != null && total > 0 ? [['ai', ai], ['vm', computer]].filter(([, v]) => (v as number) > 0) as [string, number][] : [];
  return (
    <div className="usage-hero">
      <div className="usage-hero__label">{computer != null ? 'Total cost' : 'Cost'}</div>
      <div className="usage-hero__row">
        <span className="usage-hero__value">{fmtUsd(total)}</span>
        {days > 1 && total > 0 && <span className="usage-hero__rate">{fmtUsd(total / days)} a day</span>}
      </div>
      {computer != null ? (
        <>
          {parts.length > 0 && (
            <div className="usage-split" role="img" aria-label={`AI ${fmtUsd(ai)}, computer ${fmtUsd(computer)} estimated`}>
              {parts.map(([k, v]) => <i key={k} className={`usage-split__part usage-key--${k}`} style={{ flexGrow: v }} />)}
            </div>
          )}
          <div className="usage-split__legend">
            <span><i className="usage-key usage-key--ai" aria-hidden />AI <b>{fmtUsd(ai)}</b></span>
            <span><i className="usage-key usage-key--vm" aria-hidden />Computer <b>{fmtUsd(computer)}</b> est.</span>
          </div>
        </>
      ) : sub && <div className="usage-hero__sub">{sub}</div>}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="cfg-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A ratio against a limit; the fill turns warning near the limit and critical at it (with an icon and words, never color alone). */
function Meter({ label, used, limit, figure, note }: { label: string; used: number; limit: number; figure: string; note?: string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  const state = share >= 1 ? 'critical' : share >= 0.8 ? 'warning' : 'ok';
  return (
    <div className="usage-meter">
      <div className="usage-meter__top">
        <span className="usage-meter__label">{label}</span>
        <span className="usage-meter__figure">{figure}</span>
      </div>
      <div className="usage-meter__track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-valuetext={figure}>
        <div className={`usage-meter__fill is-${state}`} style={{ width: `${share * 100}%` }} />
      </div>
      {(state !== 'ok' || note) && (
        <div className="usage-meter__note">
          {state !== 'ok' && (
            <span className={`usage-status is-${state}`}>
              <span className="usage-status__icon" aria-hidden>{state === 'critical' ? '■' : '▲'}</span>
              {state === 'critical' ? 'Limit reached' : 'Almost at the limit'}
            </span>
          )}
          {note && <span>{note}</span>}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="usage-tile">
      <div className="usage-tile__label">{label}</div>
      <div className="usage-tile__value">{value}</div>
      {sub && <div className="usage-tile__sub">{sub}</div>}
    </div>
  );
}

/**
 * Column chart, one column per UTC day. With computer costs it stacks two series (AI below, the
 * computer above, a 2px surface gap between); otherwise a single series. Per-column tooltip on hover
 * and focus, a legend whenever there are two series, and a table view.
 */
function DailyChart({ days, metric, withComputer }: { days: UsageReport['days']; metric: 'cost' | 'tokens'; withComputer: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const stacked = metric === 'cost' && withComputer;
  const ai = (d: UsageReport['days'][number]) => (metric === 'cost' ? d.costUsd : d.tokens);
  const value = (d: UsageReport['days'][number]) => ai(d) + (stacked ? d.computerUsd : 0);
  const fmt = (v: number) => (metric === 'cost' ? fmtUsd(v) : compact(v));
  const ticks = niceTicks(Math.max(...days.map(value), 0));
  const top = ticks[ticks.length - 1] || 1;
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // About one date label per 56px, so labels never collide however narrow the chart gets. The last day is
  // always labelled, right-aligned to the plot's edge, so no other label may start within ~96px of that edge.
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(width / 56))));
  const clearOfLast = Math.ceil(96 / Math.max(1, width / Math.max(1, days.length)));
  // Pointer → column, from the x position: works for a mouse, a tap, and a finger dragged along the chart.
  const pick = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setHover(Math.min(days.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * days.length))));
  };
  // A tapped tooltip stays until the next tap elsewhere (lifting a finger also "leaves" the chart).
  useEffect(() => {
    if (hover === null) return;
    const away = (e: PointerEvent) => { if (!plot.current?.contains(e.target as Node)) setHover(null); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [hover]);
  const h = hover !== null ? days[hover] : null;
  const at = hover !== null ? (hover + 0.5) / days.length : 0;
  const tipShift = at < 0.2 ? '0%' : at > 0.8 ? '-100%' : '-50%';
  const title = metric === 'cost' ? 'Daily cost' : 'Daily tokens';
  const peak = days.reduce((a, d) => (value(d) > value(a) ? d : a), days[0]);
  const detail = (d: UsageReport['days'][number]) =>
    [stacked ? `AI ${fmtUsd(d.costUsd)} · computer ${fmtUsd(d.computerUsd)}` : metric === 'cost' ? `${compact(d.tokens)} tokens` : fmtUsd(d.costUsd), plural(d.requests, 'request')].join(' · ');
  return (
    <div className="usage-card">
      <div className="usage-card__head">
        <div className="usage-card__title">{title} <span className="usage-card__hint">UTC days</span></div>
        {stacked && (
          <div className="usage-legend" aria-label="Legend">
            <span><i className="usage-key usage-key--ai" aria-hidden />AI</span>
            <span><i className="usage-key usage-key--vm" aria-hidden />Computer (estimated)</span>
          </div>
        )}
      </div>
      {/* Phones: a fixed readout instead of a tooltip under the finger. */}
      <div className="usage-readout" aria-live="polite">
        <div className="usage-readout__title">{h ? `${dayLong(h.day)} · ${fmt(value(h))}` : value(peak) > 0 ? `Peak ${fmt(value(peak))} on ${dayLabel(peak.day)}` : 'Nothing yet this period'}</div>
        <div className="usage-readout__detail">{h ? detail(h) : 'Tap a bar to see that day'}</div>
      </div>
      <div className="usage-chart">
        <div className="usage-chart__axis" aria-hidden>
          {[...ticks].reverse().map((t) => <span key={t}>{fmt(t)}</span>)}
        </div>
        <div ref={plot} className={`usage-chart__plot${hover !== null ? ' has-hover' : ''}`} role="group" aria-label={title} onPointerDown={pick} onPointerMove={pick} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null); }}>
          {ticks.map((t) => <div key={t} className="usage-chart__grid" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden />)}
          <div className="usage-chart__cols">
            {days.map((d, i) => {
              const total = value(d);
              const vmShare = stacked && total > 0 ? d.computerUsd / total : 0;
              return (
                <div
                  key={d.day}
                  className={`usage-chart__slot${hover === i ? ' is-hover' : ''}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${dayLabel(d.day)}: ${stacked ? `${fmtUsd(total)} (AI ${fmtUsd(d.costUsd)}, computer ${fmtUsd(d.computerUsd)})` : fmt(total)}, ${compact(d.tokens)} tokens, ${plural(d.requests, 'request')}`}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <div className="usage-chart__col" style={{ height: `${(total / top) * 100}%` }}>
                    {vmShare > 0 && <div className="usage-chart__seg is-vm" style={{ flexGrow: vmShare }} />}
                    {vmShare < 1 && <div className="usage-chart__seg is-ai" style={{ flexGrow: 1 - vmShare }} />}
                  </div>
                </div>
              );
            })}
          </div>
          {h && hover !== null && (
            <div className="usage-tip" style={{ left: `${at * 100}%`, transform: `translateX(${tipShift})` }} role="status">
              <div className="usage-tip__value">{fmt(value(h))}</div>
              {stacked && (
                <>
                  <div className="usage-tip__row"><i className="usage-tip__key usage-key--ai" aria-hidden /><b>{fmtUsd(h.costUsd)}</b> AI</div>
                  <div className="usage-tip__row"><i className="usage-tip__key usage-key--vm" aria-hidden /><b>{fmtUsd(h.computerUsd)}</b> computer (est.)</div>
                </>
              )}
              <div className="usage-tip__label">{dayLabel(h.day)} · {metric === 'cost' ? `${compact(h.tokens)} tokens` : fmtUsd(h.costUsd)} · {plural(h.requests, 'request')}</div>
            </div>
          )}
        </div>
      </div>
      <div className="usage-chart__xaxis" aria-hidden>
        {days.map((d, i) => <span key={d.day} className={i === days.length - 1 ? 'is-last' : ''}>{(i % labelEvery === 0 && days.length - i >= clearOfLast) || i === days.length - 1 ? dayLabel(d.day) : ''}</span>)}
      </div>
      <details className="usage-table">
        <summary>Show as a table</summary>
        <table>
          <thead><tr><th>Day (UTC)</th><th>{stacked ? 'AI cost' : 'Cost'}</th>{stacked && <th>Computer (est.)</th>}<th>Tokens</th><th>Requests</th></tr></thead>
          <tbody>
            {days.map((d) => <tr key={d.day}><td>{dayLabel(d.day)}</td><td>{fmtUsd(d.costUsd)}</td>{stacked && <td>{fmtUsd(d.computerUsd)}</td>}<td>{compact(d.tokens)}</td><td>{compact(d.requests)}</td></tr>)}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const hours = (h: number) => (h === 0 ? '0 h' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : compact(Math.round(h))} h`);

/** The account's computer: what it is now, how long it ran or slept, and the estimated cost. */
function ComputerCard({ data }: { data: UsageReport }) {
  const c = data.computer;
  const r = data.computerRates;
  const n = c.now;
  const isOrgo = (n?.provider ?? data.computerProvider) === 'orgo';
  const stateLabel = n ? ({ running: 'Running', asleep: 'Asleep', archived: 'Archived (disk kept)' } as const)[n.state] : null;
  const size = n?.cpus ? `${n.cpus} vCPU${n.memoryMb ? ` · ${(n.memoryMb / 1024).toFixed(2).replace(/\.?0+$/, '')} GB memory` : ''}${n.diskGb ? ` · ${n.diskGb} GB disk` : ''}` : '';
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Computer</div>
      <div className="usage-card">
        {n && (
          <div className="usage-vm-now">
            <div className="usage-vm-now__line">
              <span className={`usage-vm-dot is-${n.state}`} aria-hidden />
              <span className="usage-vm-now__state">{n.state === 'archived' ? stateLabel : `${stateLabel} now`}</span>
              <span className="usage-vm-now__rate">· about ${n.perHourUsd.toFixed(n.perHourUsd < 0.1 ? 3 : 2)} an hour</span>
            </div>
            {size && <div className="usage-vm-now__size">{size}</div>}
          </div>
        )}
        <div className="usage-tiles usage-tiles--compact">
          <Tile label="Running" value={hours(c.runningHours)} />
          <Tile label="Asleep" value={hours(c.asleepHours + c.archivedHours)} />
          <Tile label="Estimated cost" value={fmtUsd(c.costUsd)} />
        </div>
        <details className="usage-explain">
          <summary>How it’s estimated</summary>
          <p className="usage-card__note">{isOrgo
            ? `Estimated at Orgo's pay-as-you-go rates: ${fmtUsd(r.orgo.runningHour)} an hour running, ${fmtUsd(r.orgo.stoppedHour)} stopped. Your Orgo plan may include this time.`
            : `Estimated from Fly.io's published prices: ${fmtUsd(r.fly.cpuMonth)} per shared vCPU and ${fmtUsd(r.fly.ramGbMonth)} per extra GB of RAM a month while running, ${fmtUsd(r.fly.volumeGbMonth)} per GB of disk a month always, and only the root disk while asleep. Fly bills by the second and doesn't report each VM's cost back, so Swarm adds it up every minute.`}</p>
        </details>
      </div>
    </section>
  );
}

/** Ranked horizontal bars (one hue): a name, a bar and a figure per row, largest first. */
/** What a row used, in its own unit: tokens, or voice minutes / recordings / characters for audio. */
function rowSub(r: UsageRow): string {
  const parts: string[] = [];
  if (r.tokens > 0) parts.push(`${compact(r.tokens)} tokens`);
  if (r.minutes > 0) parts.push(`${compact(Math.round(r.minutes))} min`);
  if (r.recordings > 0) parts.push(plural(r.recordings, 'recording'));
  if (r.characters > 0) parts.push(`${compact(r.characters)} characters`);
  if (r.requests > 0 || !r.computerHours) parts.push(plural(r.requests, 'request'));
  if (r.computerHours) parts.push(`${hours(r.computerHours)} computer`);
  return parts.join(' · ');
}

const rowCost = (r: UsageRow) => r.costUsd + (r.computerUsd ?? 0);
const rowFigure = (r: UsageRow, byCost: boolean) => (!byCost ? compact(r.tokens) : rowCost(r) === 0 && r.unpriced === r.requests && r.requests > 0 ? 'No price' : fmtUsd(rowCost(r)));

function RankedList({ title, rows, byCost }: { title: string; rows: UsageRow[]; byCost: boolean }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const v = (r: UsageRow) => (byCost ? rowCost(r) : r.tokens);
  const sorted = [...rows].sort((a, b) => v(b) - v(a) || b.requests - a.requests);
  const max = Math.max(...sorted.map(v), 0) || 1;
  const sum = sorted.reduce((n, r) => n + v(r), 0);
  const of = !byCost ? 'of tokens' : rows.some((r) => r.computerUsd) ? 'of total' : 'of AI';
  const share = (r: UsageRow) => (v(r) <= 0 || sum <= 0 ? '' : v(r) / sum < 0.005 ? `<1% ${of}` : `${Math.round((v(r) / sum) * 100)}% ${of}`);
  const shown = all ? sorted : sorted.slice(0, 8);
  return (
    <div className="usage-card">
      <div className="usage-card__title">{title}</div>
      <ul className="usage-ranked">
        {shown.map((r) => (
          <li key={r.key || r.label} className="usage-ranked__row" tabIndex={0} aria-label={`${r.label}: ${rowFigure(r, true)}, ${rowSub(r)}`}>
            <span className="usage-ranked__label">{r.label}</span>
            <span className="usage-ranked__figure">{rowFigure(r, byCost)}</span>
            <div className="usage-ranked__bar" aria-hidden>{v(r) > 0 && <div style={{ width: `${(v(r) / max) * 100}%` }} />}</div>
            <span className="usage-ranked__sub">{rowSub(r)}</span>
            <span className="usage-ranked__share">{share(r)}</span>
          </li>
        ))}
      </ul>
      {sorted.length > 8 && <button type="button" className="link-btn link-btn--small" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${sorted.length}`}</button>}
    </div>
  );
}

function ProviderCard({ data }: { data: ProviderUsage }) {
  const o = data.openrouter;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Provider account</div>
      <div className="usage-card">
        {o ? (
          <>
            <div className="usage-card__title">OpenRouter{o.label ? ` · ${o.label}` : ''}</div>
            <div className="usage-tiles usage-tiles--compact">
              <Tile label="Today" value={fmtUsd(o.usage.today)} />
              <Tile label="This week" value={fmtUsd(o.usage.week)} />
              <Tile label="This month" value={fmtUsd(o.usage.month)} />
              <Tile label="All time" value={fmtUsd(o.usage.allTime)} />
            </div>
            {o.limit != null && o.limitRemaining != null && (
              <Meter label="Key credit limit" used={Math.max(0, o.limit - o.limitRemaining)} limit={o.limit}
                figure={`${fmtUsd(o.limitRemaining)} left of ${fmtUsd(o.limit)}`} note={o.limitReset ? `Resets ${o.limitReset}.` : undefined} />
            )}
            {o.budgets.filter((b) => b.limitUsd != null).map((b, i) => (
              <Meter key={i} label={`Budget${b.scope ? ` (${b.scope})` : ''}`} used={b.spendUsd ?? 0} limit={b.limitUsd!}
                figure={`${fmtUsd(b.spendUsd)} of ${fmtUsd(b.limitUsd)}`} note={b.resetInterval ? `Resets ${b.resetInterval}.` : undefined} />
            ))}
          </>
        ) : null}
        <div className="usage-card__note">{data.note}</div>
      </div>
    </section>
  );
}

// ---------- the page ----------

export function UsageSection() {
  const [range, setRange] = useState<UsageRange>('30d');
  const [scope, setScope] = useState<'me' | 'all'>('me');
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderUsage | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    configApi.usage(range, scope)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range, scope]);

  const canSeeAll = !!data?.canSeeAll;
  useEffect(() => { if (canSeeAll && !provider) configApi.usageProvider().then(setProvider).catch(() => {}); }, [canSeeAll, provider]);

  const t = data?.totals;
  const vm = data?.computer;
  const hasComputer = !!vm && (vm.costUsd > 0 || vm.runningHours > 0 || vm.asleepHours > 0 || vm.archivedHours > 0 || !!vm.now);
  const byCost = !!t && (t.costUsd > 0 || (hasComputer && vm!.costUsd > 0));
  const subCost = useMemo(() => {
    if (!t) return undefined;
    const parts: string[] = [];
    if (t.estimatedUsd > 0) parts.push(`${fmtUsd(t.estimatedUsd)} estimated`);
    if (t.unpricedVoice > 0) parts.push('voice minutes have no reported price');
    const other = t.unpricedRequests - t.unpricedVoice;
    if (other > 0) parts.push(`${plural(other, 'request')} without a price`);
    return parts.join(' · ') || 'As reported by the provider';
  }, [t]);
  const limit = data?.limits.dailyMessages;
  // Phones: "Month" keeps all four periods on one full-width row.
  const phone = useStore((s) => s.mobile);
  const ranges = phone ? RANGES.map((r) => (r.value === 'month' ? { ...r, label: 'Month' } : r)) : RANGES;
  const days = data?.days ?? [];
  const span = days.length ? `${days.length > 1 ? `${dayLabel(days[0].day)} – ${dayLabel(days[days.length - 1].day)} · UTC days` : `${dayLabel(days[0].day)} · UTC`}` : null;
  const csv = `/api/usage/export.csv?range=${range}&scope=${scope}`;
  const voiceCalls = data?.byModel.filter((r) => r.minutes > 0).reduce((n, r) => n + r.requests, 0) ?? 0;
  const provenance = `AI costs are what ${data?.provider === 'openrouter' ? 'OpenRouter' : 'the provider'} reports for each request.${hasComputer ? (data?.computer.now?.provider ?? data?.computerProvider) === 'orgo' ? ' Computer time is estimated from Orgo’s rates.' : ' Computer time is estimated from Fly.io’s published prices.' : ''}`;

  return (
    <div className="usage-page">
      <PageHead span={span} scope={canSeeAll ? <Seg label="Whose usage" value={scope} options={[{ value: 'me', label: 'Me' }, { value: 'all', label: 'Everyone' }]} onChange={setScope} /> : undefined} />
      <div className="usage-filters">
        <Seg label="Period" value={range} options={ranges} onChange={setRange} />
        <a className="cfg-btn cfg-btn--secondary usage-filters__csv" href={csv} download>Download CSV</a>
      </div>

      {error && <div className="cfg-error">{error}</div>}
      {!data && !error && <div className="cfg-empty cfg-empty--flat">Loading…</div>}

      {data && t && (
        <div className={`usage-root${loading ? ' is-loading' : ''}`}>
          {limit && scope === 'me' && (
            <section className="cfg-section">
              <div className="cfg-section__label">Your plan</div>
              <div className="usage-card">
                <Meter label="Messages today" used={limit.used} limit={limit.limit} figure={`${compact(limit.used)} of ${compact(limit.limit)}`}
                  note={`Resets at midnight UTC (${inHours(limit.resetsAt)}).`} />
              </div>
            </section>
          )}

          <Hero ai={t.costUsd} computer={hasComputer ? vm!.costUsd : null} days={days.length} sub={subCost} />
          <div className="usage-tiles">
            <Tile label="Tokens" value={compact(t.inputTokens + t.outputTokens)} sub={`${compact(t.inputTokens)} in · ${compact(t.outputTokens)} out${t.cachedTokens ? ` · ${compact(t.cachedTokens)} cached` : ''}`} />
            <Tile label="AI requests" value={compact(t.requests)} sub={t.toolCalls ? plural(t.toolCalls, 'web search', 'web searches') : undefined} />
            {t.voiceMinutes > 0 && <Tile label="Voice" value={`${compact(Math.round(t.voiceMinutes))} min`} sub={voiceCalls ? plural(voiceCalls, 'call') : undefined} />}
            {hasComputer && <Tile label="Computer" value={hours(vm!.runningHours)} sub={`running · ${hours(vm!.asleepHours + vm!.archivedHours)} asleep`} />}
          </div>

          {t.requests === 0 && !hasComputer ? (
            <div className="cfg-empty cfg-empty--flat">No AI usage in this period yet.</div>
          ) : (
            <>
              {data.days.length > 1 && <DailyChart days={data.days} metric={byCost ? 'cost' : 'tokens'} withComputer={hasComputer} />}
              {hasComputer && scope === 'me' && <ComputerCard data={data} />}
              {data.byUser && <RankedList title="By account" rows={data.byUser} byCost={byCost} />}
              <RankedList title="By Bot" rows={data.byBot} byCost={byCost} />
              <RankedList title="By model" rows={data.byModel} byCost={byCost} />
              <RankedList title="By activity" rows={data.byKind} byCost={byCost} />
            </>
          )}
        </div>
      )}

      {canSeeAll && provider && <ProviderCard data={provider} />}

      {/* Phones: export sits at the end, with where the numbers come from. */}
      {data && (
        <div className="usage-foot">
          <a className="usage-foot__csv" href={csv} download><Download size={16} strokeWidth={1.75} aria-hidden />Export CSV</a>
          <p className="usage-foot__note">{provenance}</p>
        </div>
      )}
    </div>
  );
}
