import { modelDisplayName } from '../../lib/modelDisplay';
import { ProviderLabel, ProviderMark } from '../ProviderMark';
import { SettingIcon } from './SettingRow';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Clock3, CircleUserRound, Download, Gauge } from 'lucide-react';
import { useStore } from '../../store';
import { AccessRow } from './AccessRow';
import { configApi, type ProviderUsage, type UsageCoverage, type UsageRange, type UsageReport, type UsageRow } from '../../lib/configApi';
import { billingProviderName, computerTimeNote, requestHeadline, reportRangeLabel, tokenCoverageNote } from '../../lib/usageCopy';
import '../../styles/usage.css';

/**
 * Settings → Usage: what the Bots' AI use costs, from what the providers report per request.
 * Everyone sees their own usage (and the free plan's daily allowance); the server's owner can
 * switch to everyone and sees the provider account (BYOK) itself.
 */

const RANGES: { value: UsageRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
];

// ---------- formatting ----------

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
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
const incomplete = (value: UsageCoverage) => (value.partialUsageRequests ?? 0) + (value.unavailableUsageRequests ?? 0);
const tokenFigure = (tokens: number, value: UsageCoverage & { requests: number }) => value.requests > 0 && value.knownTokenRequests === 0
  ? 'Unavailable' : `${compact(tokens)}${incomplete(value) ? ' known' : ''}`;
const dayLong = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const inHours = (t: number) => {
  const h = Math.max(0, Math.round((t - Date.now()) / 3_600_000));
  return h < 1 ? 'in under an hour' : `in ${h} h`;
};

/** Clean axis ticks from 0 up past `max` (1 / 2 / 2.5 / 5 × 10^n steps, at most 5 ticks). */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const p = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s * 4 >= max) ?? 10 * p;
  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, i) => i * step);
}

// ---------- pieces ----------

/** The same selected period is visible at every width. */
function PageHead({ span }: { span: string | null }) {
  return (
    <div className="app-settings__head usage-head">
      <div className="usage-head__text">
        <h1>Understand reported usage</h1>
        <p>Filter the report before comparing charges or downloading a CSV.</p>
        {span && <p className="usage-head__span">{span}</p>}
      </div>
    </div>
  );
}

/** Requests and costs grouped by the billing source recorded in this period. */
function Hero({ data, hasComputer }: { data: UsageReport; hasComputer: boolean }) {
  const note = tokenCoverageNote(data.totals);
  return (
    <div className="usage-hero">
      <div className="usage-report__summary">
        <span>Requests this period</span>
        <strong>{requestHeadline(data.totals.requests)}</strong>
        {note && <p className="usage-card__note" role="status">{note}</p>}
      </div>
      <div className="usage-billing">
        {data.billing.sources.map(source => {
          const plan = source.source === 'subscription';
          const provider = billingProviderName(source.provider);
          const unpriced = source.unpricedRequests === source.requests;
          return <div className="usage-billing__source" key={`${source.source}:${source.provider}`}>
            <div className="usage-hero__label">{plan ? 'CLI plan usage' : 'API provider usage'} · <ProviderLabel provider={source.provider}>{provider}</ProviderLabel></div>
            <div className="usage-billing__value">{plan ? requestHeadline(source.requests) : unpriced ? 'Price not reported' : fmtUsd(source.costUsd)}</div>
            <div className="usage-hero__sub">{plan
              ? `Included in ${data.scope === 'all' ? "the request owner's" : 'your'} ${provider} subscription; no Swarm API charge.`
              : `${requestHeadline(source.requests)} · Billed through ${provider}`}</div>
            {source.estimatedUsd > 0 && <div className="usage-card__note">Includes {fmtUsd(source.estimatedUsd)} in estimated API cost.</div>}
            {source.unpricedRequests > 0 && <div className="usage-card__note">Price not reported for {requestHeadline(source.unpricedRequests)}.</div>}
          </div>;
        })}
        {hasComputer && <div className="usage-billing__source">
          <div className="usage-hero__label">Computer time</div>
          <div className="usage-billing__value">{fmtUsd(data.computer.costUsd)} estimated</div>
        </div>}
      </div>
      <p className="usage-card__note usage-billing__note">{data.billing.note}</p>
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
 * Column chart, one column per account calendar day. With computer costs it stacks two series (AI below, the
 * computer above); otherwise a single series. Per-column tooltip on hover
 * and focus, a legend whenever there are two series, and a table view.
 */
function DailyChart({ days, metric, withComputer, timezone }: { timezone: string; days: UsageReport['days']; metric: 'cost' | 'tokens'; withComputer: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const stacked = metric === 'cost' && withComputer;
  const ai = (d: UsageReport['days'][number]) => (metric === 'cost' ? d.costUsd : d.tokens);
  const value = (d: UsageReport['days'][number]) => ai(d) + (stacked ? d.computerUsd : 0);
  const fmt = (v: number) => (metric === 'cost' ? fmtUsd(v) : compact(v));
  const figure = (day: UsageReport['days'][number]) => metric === 'tokens' ? tokenFigure(day.tokens, day) : fmt(value(day));
  const tokenDetail = (day: UsageReport['days'][number]) => day.requests > 0 && day.knownTokenRequests === 0 ? 'Token usage unavailable' : `${tokenFigure(day.tokens, day)} tokens`;
  const ticks = niceTicks(Math.max(...days.map(value), 0) * 1.15);
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
  const computerOnly = (d: UsageReport['days'][number]) => stacked && d.costUsd === 0 && d.computerUsd > 0;
  const detail = (d: UsageReport['days'][number]) =>
    [stacked ? `AI ${fmtUsd(d.costUsd)} · computer (estimated) ${fmtUsd(d.computerUsd)}` : metric === 'cost' ? tokenDetail(d) : fmtUsd(d.costUsd), ...(computerOnly(d) ? ['Only estimated computer cost'] : []), plural(d.requests, 'request'), ...(incomplete(d) ? ['Incomplete token counts'] : [])].join(' · ');
  return (
    <div className="usage-card">
      <div className="usage-card__head">
        <div className="usage-card__title">{title} <span className="usage-card__hint">{timezone}</span></div>
        {stacked && (
          <div className="usage-legend" aria-label="Legend">
            <span><i className="usage-key usage-key--ai" aria-hidden />AI</span>
            <span><i className="usage-key usage-key--vm" aria-hidden />Computer (estimated)</span>
          </div>
        )}
      </div>
      {/* Phones: a fixed readout instead of a tooltip under the finger. */}
      <div className="usage-readout" aria-live="polite">
        <div className="usage-readout__title">{h ? `${dayLong(h.day)} · ${figure(h)}` : value(peak) > 0 ? `Peak ${figure(peak)} on ${dayLabel(peak.day)}` : days.some(day => incomplete(day)) ? 'Token counts incomplete' : 'Nothing yet this period'}</div>
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
              // Computer totals can allocate fractions of a cent to otherwise empty days.
              // Omit each cost series that rounds to zero cents before sizing the stack.
              const aiAmount = metric === 'cost' && Number(d.costUsd.toFixed(2)) === 0 ? 0 : ai(d);
              const vmAmount = stacked && Number(d.computerUsd.toFixed(2)) > 0 ? d.computerUsd : 0;
              const paintedTotal = aiAmount + vmAmount;
              const vmShare = paintedTotal > 0 ? vmAmount / paintedTotal : 0;
              return (
                <div
                  key={d.day}
                  className={`usage-chart__slot${hover === i ? ' is-hover' : ''}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${dayLabel(d.day)}: ${stacked ? `${fmtUsd(total)} (AI ${fmtUsd(d.costUsd)}, computer (estimated) ${fmtUsd(d.computerUsd)})` : figure(d)}, ${tokenDetail(d)}, ${plural(d.requests, 'request')}${incomplete(d) ? ', incomplete token counts' : ''}`}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  {paintedTotal > 0 && <div className="usage-chart__col" style={{ height: `${(paintedTotal / top) * 100}%` }}>
                    {vmShare > 0 && <div className="usage-chart__seg is-vm" style={{ flexGrow: vmShare }} />}
                    {vmShare < 1 && <div className="usage-chart__seg is-ai" style={{ flexGrow: 1 - vmShare }} />}
                  </div>}
                </div>
              );
            })}
          </div>
          {h && hover !== null && (
            <div className="usage-tip" style={{ left: `${at * 100}%`, transform: `translateX(${tipShift})` }} role="status">
              <div className="usage-tip__value">{figure(h)}</div>
              {stacked && (
                <>
                  <div className="usage-tip__row"><i className="usage-tip__key usage-key--ai" aria-hidden /><b>{fmtUsd(h.costUsd)}</b> AI</div>
                  <div className="usage-tip__row"><i className="usage-tip__key usage-key--vm" aria-hidden /><b>{fmtUsd(h.computerUsd)}</b> computer (est.)</div>
                  {computerOnly(h) && <div className="usage-tip__label">Only estimated computer cost</div>}
                </>
              )}
              <div className="usage-tip__label">{dayLabel(h.day)} · {metric === 'cost' ? tokenDetail(h) : fmtUsd(h.costUsd)} · {plural(h.requests, 'request')}{incomplete(h) ? ' · Incomplete token counts' : ''}</div>
            </div>
          )}
        </div>
      </div>
      <div className="usage-chart__xaxis" aria-hidden>
        {days.map((d, i) => <span key={d.day} className={i === days.length - 1 ? 'is-last' : ''}>{(i % labelEvery === 0 && days.length - i >= clearOfLast) || i === days.length - 1 ? dayLabel(d.day) : ''}</span>)}
      </div>
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
          <Tile label="Computer on" value={hours(c.runningHours)} />
          <Tile label="Asleep" value={hours(c.asleepHours + c.archivedHours)} />
          <Tile label="Estimated cost" value={fmtUsd(c.costUsd)} />
        </div>
        <p className="usage-card__note">{computerTimeNote}{data.timezone && data.timezone !== 'UTC' && ' Daily computer estimates are split from UTC totals to fit your time zone.'}</p>
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
  if (r.tokens > 0) parts.push(`${tokenFigure(r.tokens, r)} tokens`);
  else if (r.requests > 0 && r.knownTokenRequests === 0) parts.push('Token usage unavailable');
  if (incomplete(r)) parts.push(`${plural(incomplete(r), 'request')} with incomplete token counts`);
  if (r.minutes > 0) parts.push(`${compact(Math.round(r.minutes))} min`);
  if (r.recordings > 0) parts.push(plural(r.recordings, 'recording'));
  if (r.characters > 0) parts.push(`${compact(r.characters)} characters`);
  if (r.requests > 0 || !r.computerHours) parts.push(plural(r.requests, 'request'));
  if (r.computerHours) parts.push(`${hours(r.computerHours)} computer`);
  return parts.join(' · ');
}

const rowCost = (r: UsageRow) => r.costUsd + (r.computerUsd ?? 0);
const rowFigure = (r: UsageRow, byCost: boolean) => (!byCost ? tokenFigure(r.tokens, r) : rowCost(r) === 0 && r.unpriced === r.requests && r.requests > 0 ? 'No price' : fmtUsd(rowCost(r)));

function RankedList({ title, rows, byCost, models = false }: { title: string; rows: UsageRow[]; byCost: boolean; models?: boolean }) {
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
          <li key={r.key || r.label} className="usage-ranked__row" tabIndex={0} aria-label={`${models ? modelDisplayName(r.key, r.label) : r.label}: ${rowFigure(r, true)}, ${rowSub(r)}`}>
            <span className="usage-ranked__label">{models ? <ProviderLabel provider={r.key}>{modelDisplayName(r.key, r.label)}</ProviderLabel> : r.label}</span>
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
      <AccessRow icon={CircleUserRound} title="Provider account" description={data.note} />
      {o && <div className="usage-card">
        <div className="usage-card__title"><ProviderMark provider="openrouter" /> OpenRouter{o.label ? ` · ${o.label}` : ''}</div>
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
        {o.budgets.filter(b => b.limitUsd != null).map((b, i) => b.spendUsd == null
          ? <AccessRow icon={Gauge} key={i} title={`Budget${b.scope ? ` (${b.scope})` : ''}`} description="Spend not reported" status={`${fmtUsd(b.limitUsd)} limit`} />
          : <Meter key={i} label={`Budget${b.scope ? ` (${b.scope})` : ''}`} used={b.spendUsd} limit={b.limitUsd!}
            figure={`${fmtUsd(b.spendUsd)} of ${fmtUsd(b.limitUsd)}`} note={b.resetInterval ? `Resets ${b.resetInterval}.` : undefined} />)}
      </div>}
    </section>
  );
}

// ---------- the page ----------

export function UsageSection() {
  const accountId = useStore(s => s.user?.id);
  return <AccountUsageReport key={accountId} />;
}

function AccountUsageReport() {
  const [range, setRange] = useState<UsageRange>('7d');
  const [scope, setScope] = useState<'me' | 'all'>('me');
  const [report, setReport] = useState<{ range: UsageRange; scope: 'me' | 'all'; data: UsageReport } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [providerAttempt, setProviderAttempt] = useState(0);
  const [reportView, setReportView] = useState<'chart' | 'table'>('chart');
  const [breakdown, setBreakdown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderUsage | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    configApi.usage(range, scope)
      .then((d) => { if (alive) { if (d.scope !== scope) setScope(d.scope); setReport({ range, scope: d.scope, data: d }); } })
      .catch((e) => { if (alive) { setReport(null); setError((e as Error).message); } });
    return () => { alive = false; };
  }, [range, scope, attempt]);

  const data = report?.range === range && report.scope === scope ? report.data : null;
  const canSeeAll = !!report?.data.canSeeAll;
  const canSeeProvider = data?.canSeeProvider ?? canSeeAll;
  useEffect(() => {
    if (!canSeeProvider) { setProvider(null); setProviderError(null); return; }
    let alive = true;
    setProvider(null); setProviderError(null);
    configApi.usageProvider().then(value => { if (alive) setProvider(value); }).catch(e => { if (alive) setProviderError((e as Error).message); });
    return () => { alive = false; };
  }, [canSeeProvider, providerAttempt]);

  const t = data?.totals;
  const vm = data?.computer;
  const hasComputer = !!vm && (vm.costUsd > 0 || vm.runningHours > 0 || vm.asleepHours > 0 || vm.archivedHours > 0 || !!vm.now);
  const byCost = !!t && (t.costUsd > 0 || (hasComputer && vm!.costUsd > 0));
  const limit = data?.limits.dailyMessages;
  const days = data?.days ?? [];
  const span = reportRangeLabel(days, data?.timezone);
  const csv = `/api/usage/export.csv?range=${range}&scope=${scope}`;
  const voiceCalls = data?.byModel.filter((r) => r.minutes > 0).reduce((n, r) => n + r.requests, 0) ?? 0;

  return (
    <div className="usage-page">
      <PageHead span={span} />
      <div className="usage-filters">
        <label className="cfg-field"><SettingIcon icon={Clock3} /><span className="cfg-field__label">Report period</span><select className="text-input" value={range} onChange={event => setRange(event.target.value as UsageRange)}>{RANGES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="cfg-field"><SettingIcon icon={CircleUserRound} /><span className="cfg-field__label">Scope</span><select className="text-input" value={scope} onChange={event => setScope(event.target.value === 'all' ? 'all' : 'me')} disabled={!canSeeAll}><option value="me">Me</option>{canSeeAll && <option value="all">Everyone</option>}</select>{!canSeeAll && <span className="cfg-field__hint">Only admins can view usage for everyone.</span>}</label>
      </div>

      {error && <div role="alert" className="cfg-error">{error} <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Retry report</button></div>}
      {!data && !error && <div className="cfg-empty cfg-empty--flat" role="status">Loading usage report…</div>}

      {data && t && (
        <div className="usage-root">
          <Hero data={data} hasComputer={hasComputer} />
          <div className="usage-tiles">
            <Tile label={incomplete(t) ? 'Known tokens' : 'Tokens'} value={tokenFigure(t.inputTokens + t.outputTokens, t)} sub={`${t.knownInputRequests === 0 && t.requests > 0 ? 'Unavailable' : compact(t.inputTokens)} in · ${t.knownOutputRequests === 0 && t.requests > 0 ? 'Unavailable' : compact(t.outputTokens)} out${t.cachedTokens ? ` · ${compact(t.cachedTokens)} cached` : ''}`} />
            <Tile label="AI requests" value={compact(t.requests)} sub={t.toolCalls ? plural(t.toolCalls, 'web search', 'web searches') : undefined} />
            {t.voiceMinutes > 0 && <Tile label="Voice" value={`${compact(Math.round(t.voiceMinutes))} min`} sub={voiceCalls ? plural(voiceCalls, 'call') : undefined} />}
            {hasComputer && <Tile label="Computer on" value={hours(vm!.runningHours)} sub={`${hours(vm!.asleepHours + vm!.archivedHours)} asleep`} />}
          </div>

          {hasComputer && <p className="usage-card__note">{computerTimeNote}{data.timezone && data.timezone !== 'UTC' && ' Daily computer estimates are split from UTC totals to fit your time zone.'}</p>}

          {t.requests === 0 && !hasComputer ? (
            <div className="cfg-empty cfg-empty--flat">No AI usage in this period yet.</div>
          ) : (
            <>
              {days.length > 0 && <>
                <Seg label="Report display" value={reportView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} onChange={setReportView} />
                {reportView === 'chart' ? <DailyChart timezone={data.timezone} days={days} metric={byCost ? 'cost' : 'tokens'} withComputer={hasComputer} /> : <div className="usage-table" tabIndex={0} role="region" aria-label="Daily usage table">
                  <table>
                    <thead><tr><th>Day ({data.timezone || 'UTC'})</th><th>Recorded AI cost</th>{hasComputer && <th>Computer (est.)</th>}<th>Tokens</th><th>Requests</th></tr></thead>
                    <tbody>{days.map(day => <tr key={day.day}><td>{dayLabel(day.day)}</td><td>{day.costUsd === 0 && t.unpricedRequests > 0 && day.requests > 0 ? 'No recorded cost' : fmtUsd(day.costUsd)}</td>{hasComputer && <td>{fmtUsd(day.computerUsd)}</td>}<td>{tokenFigure(day.tokens, day)}</td><td>{compact(day.requests)}</td></tr>)}</tbody>
                  </table>
                </div>}
              </>}
              <AccessRow icon={Gauge} title="Breakdown" description="Expand account, Bot, model and activity lists."><button type="button" className="cfg-btn cfg-btn--secondary" aria-expanded={breakdown} onClick={() => setBreakdown(value => !value)}>{breakdown ? 'Show less' : 'Show more'}</button></AccessRow>
              {breakdown && <>
                {hasComputer && scope === 'me' && <ComputerCard data={data} />}
                {data.byUser && <RankedList title="By account" rows={data.byUser} byCost={byCost} />}
                <RankedList title="By Bot" rows={data.byBot} byCost={byCost} />
                <RankedList title="By model" rows={data.byModel} byCost={byCost} models />
                <RankedList title="By activity" rows={data.byKind} byCost={byCost} />
              </>}
            </>
          )}
          {scope === 'me' && limit && limit.resetsAt > Date.now() && <div className="usage-card"><Meter label="Messages today (UTC)" used={limit.used} limit={limit.limit} figure={`${compact(limit.used)} of ${compact(limit.limit)}`} note={`Resets at midnight UTC (${inHours(limit.resetsAt)}).`} /></div>}
          {scope === 'me' && !limit && <AccessRow icon={Gauge} title="Plan limits" description="No daily message limit in Swarm. Provider limits still apply." />}
        </div>
      )}

      {canSeeProvider && provider && <ProviderCard data={provider} />}
      {canSeeProvider && !provider && (providerError ? <div className="cfg-error" role="alert">{providerError} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setProviderAttempt(value => value + 1)}>Retry provider usage</button></div> : <p className="usage-card__note" role="status">Checking provider usage…</p>)}

      {/* Phones: export sits at the end, with where the numbers come from. */}
      {data && (
        <div className="usage-foot">
          <a className="cfg-btn cfg-btn--primary" href={csv} download><Download size={16} strokeWidth={1.75} aria-hidden />Download CSV</a>
        </div>
      )}
    </div>
  );
}
