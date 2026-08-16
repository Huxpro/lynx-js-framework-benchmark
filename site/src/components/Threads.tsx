// The dual-thread page: where the Lynx-specific equations become visible.
// Per case: BTS vs MTS sampled CPU, wire traffic in both directions, and the
// per-endpoint breakdown; plus the static MTS/BTS bundle-section split.
import { useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import {
  ENTRIES,
  entryColor,
  fmtBytes,
  fmtCount,
  fmtMs,
  shortLabel,
} from '../data';
import { useTooltip } from '../hooks';

const THREAD_WORKLOADS = ['create', 'update10th', 'select', 'updateStorm', 'selectStorm'];
const scaleLabel = (scale: number) => scale >= 1000 ? `${scale / 1000}k` : String(scale);
const endpointDetailLabel = (kind: string | null | undefined) => kind === 'sample-nearest-median'
  ? 'sample nearest the median total'
  : 'legacy final sample';

function GroupedTimeBars({
  workload,
  scale,
  harness,
  theme,
  selected,
}: {
  workload: string;
  scale: number;
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { one } = useBenchmarkData();
  const { setTip, onMove, tipNode } = useTooltip();
  const rows = ENTRIES.filter((e) => selected.has(e.id)).map((e) => {
    const lat = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: 'latency' });
    const bts = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: 'btsCpu' });
    const mts = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: 'mtsCpu' });
    return { id: e.id, latency: lat?.median ?? null, bts: bts?.median ?? null, mts: mts?.median ?? null };
  }).filter((r) => r.latency != null);
  rows.sort((a, b) => (a.latency as number) - (b.latency as number));
  const max = Math.max(1e-9, ...rows.flatMap((r) => [r.latency ?? 0, r.bts ?? 0, r.mts ?? 0])) * 1.08;

  const KIND: { key: 'latency' | 'bts' | 'mts'; name: string; alpha: number }[] = [
    { key: 'latency', name: 'wall latency', alpha: 1 },
    { key: 'bts', name: 'BTS CPU (background)', alpha: 0.62 },
    { key: 'mts', name: 'MTS CPU (UI thread)', alpha: 0.34 },
  ];

  return (
    <div onMouseMove={onMove}>
      <div className="bars" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.id} className="bar-row" style={{ alignItems: 'start' }}>
            <div className="bar-label" style={{ paddingTop: 2 }}>{shortLabel(r.id)}</div>
            <div
              onMouseEnter={(e) => {
                setTip({
                  head: `${shortLabel(r.id)} — ${workload} @${scale >= 1000 ? `${scale / 1000}k` : scale}`,
                  lines: [
                    `wall latency ${fmtMs(r.latency)}`,
                    `BTS CPU ${fmtMs(r.bts)} · MTS CPU ${fmtMs(r.mts)}`,
                    'BTS and MTS run concurrently — CPU bars can each exceed neither, sum may exceed wall.',
                  ],
                });
                onMove(e);
              }}
              onMouseLeave={() => setTip(null)}
            >
              {KIND.map(({ key, alpha }) => {
                const v = r[key];
                return (
                  <div key={key} className="bar-track" style={{ height: '0.62rem', marginBottom: 2, background: 'var(--surface-2)' }}>
                    {v != null && (
                      <div
                        className="bar-fill"
                        style={{ width: `${(v / max) * 100}%`, background: entryColor(r.id, theme), opacity: alpha }}
                      />
                    )}
                    <span className="bar-value" style={{ left: `${((v ?? 0) / max) * 100}%`, fontSize: '0.68rem' }}>
                      {v != null ? fmtMs(v) : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="legend" aria-hidden="false">
        {KIND.map((k) => (
          <span key={k.key} className="item" style={{ cursor: 'default' }}>
            <span className="swatch" style={{ background: 'currentColor', opacity: k.alpha }} />
            {k.name}
          </span>
        ))}
      </div>
      {tipNode}
    </div>
  );
}

function WireBars({
  workload,
  scale,
  harness,
  theme,
  selected,
  metric,
  fmt,
}: {
  workload: string;
  scale: number;
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
  metric: 'Bytes' | 'Msgs';
  fmt: (v: number | null) => string;
}) {
  const { one } = useBenchmarkData();
  const { setTip, onMove, tipNode } = useTooltip();
  const rows = ENTRIES.filter((e) => selected.has(e.id)).map((e) => {
    const down = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: `wireToMts${metric}` });
    const up = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: `wireToBts${metric}` });
    return {
      id: e.id,
      down: down?.median ?? null,
      up: up?.median ?? null,
      downDetail: down?.detail ?? null,
      upDetail: up?.detail ?? null,
      detailKind: down?.detailKind ?? up?.detailKind ?? null,
    };
  }).filter((r) => r.down != null || r.up != null);
  rows.sort((a, b) => ((a.down ?? 0) + (a.up ?? 0)) - ((b.down ?? 0) + (b.up ?? 0)));
  const max = Math.max(1e-9, ...rows.flatMap((r) => [r.down ?? 0, r.up ?? 0])) * 1.08;

  return (
    <div onMouseMove={onMove}>
      <div className="bars" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.id} className="bar-row" style={{ alignItems: 'start' }}>
            <div className="bar-label" style={{ paddingTop: 2 }}>{shortLabel(r.id)}</div>
            <div
              onMouseEnter={(e) => {
                const names = [
                  ...Object.entries(r.downDetail?.byName ?? {}).map(([name, value]) => [`BTS→MTS ${name}`, value] as const),
                  ...Object.entries(r.upDetail?.byName ?? {}).map(([name, value]) => [`MTS→BTS ${name}`, value] as const),
                ];
                names.sort((a, b) => b[1].bytes - a[1].bytes);
                setTip({
                  head: `${shortLabel(r.id)} — ${workload}`,
                  lines: [
                    `BTS→MTS ${fmt(r.down)} · MTS→BTS ${fmt(r.up)}`,
                    `two-direction total ${fmt((r.down ?? 0) + (r.up ?? 0))}`,
                    `endpoint detail: ${endpointDetailLabel(r.detailKind)}`,
                    ...names.slice(0, 4).map(([n, v]) => `${n}: ${fmtBytes(v.bytes)} / ${v.messages} msg`),
                  ],
                });
                onMove(e);
              }}
              onMouseLeave={() => setTip(null)}
            >
              {(['down', 'up'] as const).map((dir) => {
                const v = r[dir];
                return (
                  <div key={dir} className="bar-track" style={{ height: '0.62rem', marginBottom: 2 }}>
                    {v != null && (
                      <div
                        className="bar-fill"
                        style={{
                          width: `${(v / max) * 100}%`,
                          background: entryColor(r.id, theme),
                          opacity: dir === 'down' ? 1 : 0.45,
                        }}
                      />
                    )}
                    <span className="bar-value" style={{ left: `${((v ?? 0) / max) * 100}%`, fontSize: '0.68rem' }}>
                      {fmt(v)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span className="item" style={{ cursor: 'default' }}>
          <span className="swatch" style={{ background: 'currentColor' }} /> BTS→MTS (render payload)
        </span>
        <span className="item" style={{ cursor: 'default' }}>
          <span className="swatch" style={{ background: 'currentColor', opacity: 0.45 }} /> MTS→BTS (events, timing)
        </span>
        <span className="note">rows sorted by the two-direction total</span>
      </div>
      {tipNode}
    </div>
  );
}

export function ThreadsPage({
  harness,
  theme,
  selected,
}: {
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { select } = useBenchmarkData();
  const available = useMemo(
    () => THREAD_WORKLOADS.flatMap((workload) => [...new Set(
      select({ suite: 'table', harness, workload, metric: 'latency' }).map((record) => record.scale),
    )].sort((a, b) => a - b).map((scale) => ({
      key: `${workload}@${scale}`,
      workload,
      scale,
      label: `${workload} @${scaleLabel(scale)}`,
    }))),
    [harness, select],
  );
  const [caseKey, setCaseKey] = useState<string | null>(null);
  const active = available.find((c) => c.key === caseKey) ?? available[0];

  if (!active) {
    return <div className="empty-state">No dual-thread data for this harness yet.</div>;
  }

  return (
    <>
      <div className="chips" role="group" aria-label="Case">
        {available.map((c) => (
          <button key={c.key} className="chip" aria-pressed={c.key === active.key} onClick={() => setCaseKey(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-title">where the time goes — {active.label}</div>
        <div className="card-desc">
          Wall latency (tap → DOM predicate) beside per-realm sampled JS CPU. The two threads run
          concurrently: a framework can hide BTS cost behind MTS work or vice versa — or fail to.
          CPU is sampled by the V8 profiler per realm (200µs interval), so it includes GC and microtasks.
        </div>
        <GroupedTimeBars workload={active.workload} scale={active.scale} harness={harness} theme={theme} selected={selected} />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-title">wire bytes by direction — {active.label}</div>
          <div className="card-desc">
            Serialized payload crossing the BTS↔MTS boundary during the op, measured at web-core's
            rpc channel with one instrument for every framework. Each framework has separate
            directional bars, sorted by their two-direction total, so it can be lowest in one
            direction and highest in the other. Hover for the per-endpoint split.
          </div>
          <WireBars workload={active.workload} scale={active.scale} harness={harness} theme={theme} selected={selected} metric="Bytes" fmt={fmtBytes} />
        </div>
        <div className="card">
          <div className="card-title">wire messages by direction — {active.label}</div>
          <div className="card-desc">
            Message count both directions. Chatty protocols pay per-message overhead (structured
            clone, scheduling) even when bytes are small.
          </div>
          <WireBars workload={active.workload} scale={active.scale} harness={harness} theme={theme} selected={selected} metric="Msgs" fmt={fmtCount} />
        </div>
      </div>

      <EndpointTable workload={active.workload} scale={active.scale} harness={harness} selected={selected} />
      <div className="grid-2">
        <MemoryCard harness={harness} theme={theme} selected={selected} />
      </div>
      <BundleSections theme={theme} selected={selected} />
    </>
  );
}

function MemoryCard({
  harness,
  theme,
  selected,
}: {
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { one } = useBenchmarkData();
  const { setTip, onMove, tipNode } = useTooltip();
  const rows = ENTRIES.filter((e) => selected.has(e.id)).map((e) => ({
    id: e.id,
    mts: one({ suite: 'table', harness, entry: e.id, workload: 'memory', scale: 10000, metric: 'heapMts' })?.median ?? null,
    bts: one({ suite: 'table', harness, entry: e.id, workload: 'memory', scale: 10000, metric: 'heapBts' })?.median ?? null,
  })).filter((r) => r.mts != null || r.bts != null);
  if (!rows.length) return null;
  rows.sort((a, b) => ((a.bts ?? 0) + (a.mts ?? 0)) - ((b.bts ?? 0) + (b.mts ?? 0)));
  const max = Math.max(1e-9, ...rows.flatMap((r) => [r.mts ?? 0, r.bts ?? 0])) * 1.08;

  return (
    <div className="card" onMouseMove={onMove}>
      <div className="card-title">memory — GC'd heap holding 10k rows</div>
      <div className="card-desc">
        Used JS heap per realm after creating 10,000 rows and forcing GC. Indicative (one
        scenario), but the BTS/MTS asymmetry shows where each framework keeps its state.
      </div>
      <div className="bars" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.id} className="bar-row" style={{ alignItems: 'start' }}>
            <div className="bar-label" style={{ paddingTop: 2 }}>{shortLabel(r.id)}</div>
            <div
              onMouseEnter={(e) => {
                setTip({
                  head: shortLabel(r.id),
                  lines: [`BTS heap ${fmtBytes(r.bts)} · MTS heap ${fmtBytes(r.mts)}`],
                });
                onMove(e);
              }}
              onMouseLeave={() => setTip(null)}
            >
              {(['bts', 'mts'] as const).map((k) => (
                <div key={k} className="bar-track" style={{ height: '0.62rem', marginBottom: 2 }}>
                  {r[k] != null && (
                    <div
                      className="bar-fill"
                      style={{ width: `${((r[k] as number) / max) * 100}%`, background: entryColor(r.id, theme), opacity: k === 'bts' ? 1 : 0.45 }}
                    />
                  )}
                  <span className="bar-value" style={{ left: `${((r[k] ?? 0) / max) * 100}%`, fontSize: '0.68rem' }}>
                    {fmtBytes(r[k])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'currentColor' }} /> BTS heap</span>
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'currentColor', opacity: 0.45 }} /> MTS heap</span>
      </div>
      {tipNode}
    </div>
  );
}

function EndpointTable({
  workload,
  scale,
  harness,
  selected,
}: {
  workload: string;
  scale: number;
  harness: string;
  selected: Set<string>;
}) {
  const { one } = useBenchmarkData();
  const rows = ENTRIES.filter((e) => selected.has(e.id)).map((e) => {
    const down = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: 'wireToMtsBytes' });
    const up = one({ suite: 'table', harness, entry: e.id, workload, scale, metric: 'wireToBtsBytes' });
    const merge: Record<string, { messages: number; bytes: number; dir: string }> = {};
    for (const [dir, rec] of [['BTS→MTS', down], ['MTS→BTS', up]] as const) {
      for (const [name, v] of Object.entries(rec?.detail?.byName ?? {})) {
        merge[`${dir} ${name}`] = { ...v, dir };
      }
    }
    return { id: e.id, endpoints: merge, detailKind: down?.detailKind ?? up?.detailKind ?? null };
  });
  const detailKinds = new Set(rows.flatMap((row) => row.detailKind ? [row.detailKind] : []));
  const detailDescription = detailKinds.size === 1
    ? endpointDetailLabel([...detailKinds][0])
    : 'source-labelled samples (see row data)';

  return (
    <div className="card">
      <div className="card-title">per-endpoint breakdown — {detailDescription}</div>
      <div className="card-desc">
        Which rpc endpoints carried the traffic. <code>callLepusMethod</code> carries most
        frameworks' render payloads; <code>publishEvent</code>/<code>publicComponentEvent</code> carry input
        events up; <code>markTiming</code>/<code>postTimingFlags</code> are the engine's own timing chatter.
      </div>
      <details className="data-table" open>
        <summary>Endpoint table</summary>
        <table>
          <thead>
            <tr><th>entry</th><th>endpoint</th><th>msgs</th><th>bytes</th></tr>
          </thead>
          <tbody>
            {rows.flatMap((r) => {
              const entries = Object.entries(r.endpoints).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
              return entries.map(([name, v], i) => (
                <tr key={`${r.id}-${name}`}>
                  <td>{i === 0 ? shortLabel(r.id) : ''}</td>
                  <td style={{ textAlign: 'left', fontFamily: 'ui-monospace, Menlo, monospace' }}>{name}</td>
                  <td>{v.messages}</td>
                  <td>{fmtBytes(v.bytes)}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function BundleSections({ theme, selected }: { theme: 'light' | 'dark'; selected: Set<string> }) {
  const { one } = useBenchmarkData();
  const { setTip, onMove, tipNode } = useTooltip();
  const rows = ENTRIES.filter((e) => selected.has(e.id)).map((e) => ({
    id: e.id,
    mts: one({ suite: 'bundle', entry: e.id, metric: 'mtsSectionGzip' })?.median ?? null,
    bts: one({ suite: 'bundle', entry: e.id, metric: 'btsSectionGzip' })?.median ?? null,
    whole: one({ suite: 'bundle', entry: e.id, metric: 'bundleWebGzip' })?.median ?? null,
  }));
  const max = Math.max(1e-9, ...rows.map((r) => r.whole ?? 0)) * 1.08;

  return (
    <div className="card" onMouseMove={onMove}>
      <div className="card-title">bundle split — MTS vs BTS program size (gzip)</div>
      <div className="card-desc">
        How much code each thread must parse before it can work. JSON-format web bundles expose the
        split (<code>lepusCode.root</code> = main thread, <code>app-service.js</code> = background); binary
        bundles report whole-bundle only (hatched).
      </div>
      <div className="bars" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.id} className="bar-row">
            <div className="bar-label">{shortLabel(r.id)}</div>
            <div
              className="bar-track"
              style={{ height: '1.1rem' }}
              onMouseEnter={(e) => {
                setTip({
                  head: shortLabel(r.id),
                  lines: r.mts != null
                    ? [`MTS ${fmtBytes(r.mts)} · BTS ${fmtBytes(r.bts)}`, `whole bundle ${fmtBytes(r.whole)}`]
                    : [`whole bundle ${fmtBytes(r.whole)} (binary format — no section split)`],
                });
                onMove(e);
              }}
              onMouseLeave={() => setTip(null)}
            >
              {r.mts != null && r.bts != null ? (
                <>
                  <div className="bar-fill" style={{ width: `${(r.mts / max) * 100}%`, background: entryColor(r.id, theme) }} />
                  <div
                    className="bar-fill"
                    style={{
                      left: `calc(${(r.mts / max) * 100}% + 2px)`,
                      width: `${(r.bts / max) * 100}%`,
                      background: entryColor(r.id, theme),
                      opacity: 0.45,
                      borderRadius: '0 4px 4px 0',
                    }}
                  />
                </>
              ) : (
                <div
                  className="bar-fill"
                  style={{
                    width: `${((r.whole ?? 0) / max) * 100}%`,
                    background: `repeating-linear-gradient(45deg, ${entryColor(r.id, theme)}, ${entryColor(r.id, theme)} 4px, transparent 4px, transparent 8px)`,
                  }}
                />
              )}
              <span className="bar-value" style={{ left: `${((r.whole ?? 0) / max) * 100}%` }}>
                {fmtBytes(r.whole)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'currentColor' }} /> MTS section</span>
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'currentColor', opacity: 0.45 }} /> BTS section</span>
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'repeating-linear-gradient(45deg, currentColor, currentColor 3px, transparent 3px, transparent 6px)' }} /> binary (no split)</span>
      </div>
      {tipNode}
    </div>
  );
}
