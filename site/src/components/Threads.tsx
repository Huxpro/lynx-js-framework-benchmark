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
import { localizedWorkload, Locale, useI18n } from '../i18n';

const THREAD_WORKLOADS = ['create', 'update10th', 'select', 'updateStorm', 'selectStorm'];
const THREAD_METRICS = new Set(['btsCpu', 'mtsCpu', 'wireToMtsBytes', 'wireToBtsBytes']);
const scaleLabel = (scale: number) => scale >= 1000 ? `${scale / 1000}k` : String(scale);
const endpointDetailLabel = (kind: string | null | undefined, locale: Locale) => kind === 'sample-nearest-median'
  ? locale === 'zh-CN' ? '最接近总量中位数的样本' : 'sample nearest the median total'
  : locale === 'zh-CN' ? '旧版最终样本' : 'legacy final sample';

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
  const { locale, text } = useI18n();
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
    { key: 'latency', name: text('wall latency', '墙钟延迟'), alpha: 1 },
    { key: 'bts', name: text('BTS CPU (background)', 'BTS CPU（后台）'), alpha: 0.62 },
    { key: 'mts', name: text('MTS CPU (UI thread)', 'MTS CPU（UI 线程）'), alpha: 0.34 },
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
                  head: `${shortLabel(r.id)} — ${localizedWorkload(workload, locale)} @${scale >= 1000 ? `${scale / 1000}k` : scale}`,
                  lines: [
                    text(`wall latency ${fmtMs(r.latency)}`, `墙钟延迟 ${fmtMs(r.latency)}`),
                    `BTS CPU ${fmtMs(r.bts)} · MTS CPU ${fmtMs(r.mts)}`,
                    text('BTS and MTS run concurrently — CPU bars can each exceed neither, sum may exceed wall.', 'BTS 与 MTS 并发运行——每条 CPU bar 都不会超过墙钟时间，但两者之和可能超过。'),
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
                    <span
                      className={`bar-value${(v ?? 0) / max > 0.72 ? ' inside' : ''}`}
                      style={{ left: `${((v ?? 0) / max) * 100}%`, fontSize: '0.68rem' }}
                    >
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
  const { locale, text } = useI18n();
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
                  head: `${shortLabel(r.id)} — ${localizedWorkload(workload, locale)}`,
                  lines: [
                    `BTS→MTS ${fmt(r.down)} · MTS→BTS ${fmt(r.up)}`,
                    text(`two-direction total ${fmt((r.down ?? 0) + (r.up ?? 0))}`, `双向总计 ${fmt((r.down ?? 0) + (r.up ?? 0))}`),
                    text(`endpoint detail: ${endpointDetailLabel(r.detailKind, locale)}`, `endpoint 明细：${endpointDetailLabel(r.detailKind, locale)}`),
                    ...names.slice(0, 4).map(([n, v]) => text(`${n}: ${fmtBytes(v.bytes)} / ${v.messages} msg`, `${n}：${fmtBytes(v.bytes)} / ${v.messages} 条消息`)),
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
                    <span
                      className={`bar-value${(v ?? 0) / max > 0.72 ? ' inside' : ''}`}
                      style={{ left: `${((v ?? 0) / max) * 100}%`, fontSize: '0.68rem' }}
                    >
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
          <span className="swatch" style={{ background: 'currentColor' }} /> BTS→MTS {text('(render payload)', '（渲染 payload）')}
        </span>
        <span className="item" style={{ cursor: 'default' }}>
          <span className="swatch" style={{ background: 'currentColor', opacity: 0.45 }} /> MTS→BTS {text('(events, timing)', '（事件、计时）')}
        </span>
        <span className="note">{text('rows sorted by the two-direction total', '按双向总量排序')}</span>
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
  const { locale, text } = useI18n();
  const { select } = useBenchmarkData();
  const available = useMemo(
    () => THREAD_WORKLOADS.flatMap((workload) => [...new Set(
      select({ suite: 'table', harness, workload, metric: 'latency' }).map((record) => record.scale),
    )].sort((a, b) => a - b)
      .filter((scale) => select({ suite: 'table', harness, workload, scale })
        .some((record) => THREAD_METRICS.has(record.metric)))
      .map((scale) => ({
        key: `${workload}@${scale}`,
        workload,
        scale,
        label: `${localizedWorkload(workload, locale)} @${scaleLabel(scale)}`,
      }))),
    [harness, locale, select],
  );
  const [caseKey, setCaseKey] = useState<string | null>(null);
  const active = available.find((c) => c.key === caseKey) ?? available[0];

  if (!active) {
    return (
      <div className="empty-state compact-empty">
        <b>{text(`No thread or transport samples for Lynx for ${harness === 'web' ? 'Web' : 'Native'}.`, `Lynx ${harness === 'web' ? 'Web' : 'Native'} 暂无线程或 transport 样本。`)}</b>
        <span>
          {text(
            'Headline latency remains valid; this checkpoint did not capture the per-realm CPU and directional wire instruments needed for the breakdown.',
            '核心延迟仍然有效；此节点没有采集拆分所需的各 realm CPU 和分方向 wire 测量。',
          )}
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="chips" role="group" aria-label={text('Case', 'Case')}>
        {available.map((c) => (
          <button key={c.key} className="chip" aria-pressed={c.key === active.key} onClick={() => setCaseKey(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-title">{text('where the time goes', '时间花在哪里')} — {active.label}</div>
        <div className="card-desc">
          {text(
            'Wall latency (tap → DOM predicate) beside per-realm sampled JS CPU. The two threads run concurrently: a framework can hide BTS cost behind MTS work or vice versa — or fail to. CPU is sampled by the V8 profiler per realm (200µs interval), so it includes GC and microtasks.',
            '并列展示墙钟延迟（点击 → DOM 条件）与各 realm 采样的 JS CPU。两个线程并发运行：框架可能把 BTS 成本隐藏在 MTS 工作之后，反之亦然，也可能做不到。CPU 由 V8 profiler 按 realm 采样（间隔 200µs），因此包含 GC 和 microtask。',
          )}
        </div>
        <GroupedTimeBars workload={active.workload} scale={active.scale} harness={harness} theme={theme} selected={selected} />
      </div>

      <div className="wire-analysis">
        <div className="grid-2">
          <div className="card">
            <div className="card-title">{text('wire bytes by direction', '按方向拆分 wire 字节')} — {active.label}</div>
            <div className="card-desc">
              {text(
                "Serialized payload crossing the BTS↔MTS boundary during the op, measured at web-core's rpc channel with one instrument for every framework. Each framework has separate directional bars, sorted by their two-direction total, so it can be lowest in one direction and highest in the other. Hover for the per-endpoint split.",
                '操作期间跨越 BTS↔MTS 边界的序列化 payload，由 web-core rpc channel 对所有框架使用同一测量工具。每个框架按方向分别绘制，并按双向总量排序，因此它可能在一个方向最低、另一个方向最高。悬停可查看各 endpoint 拆分。',
              )}
            </div>
            <WireBars workload={active.workload} scale={active.scale} harness={harness} theme={theme} selected={selected} metric="Bytes" fmt={fmtBytes} />
          </div>
          <div className="card">
            <div className="card-title">{text('wire messages by direction', '按方向拆分 wire 消息')} — {active.label}</div>
            <div className="card-desc">
              {text(
                'Message count both directions. Chatty protocols pay per-message overhead (structured clone, scheduling) even when bytes are small.',
                '统计双向消息数。即使字节数很小，频繁通信的协议仍需承担逐消息开销（structured clone、调度）。',
              )}
            </div>
            <WireBars workload={active.workload} scale={active.scale} harness={harness} theme={theme} selected={selected} metric="Msgs" fmt={fmtCount} />
          </div>
        </div>
        <EndpointTable workload={active.workload} scale={active.scale} harness={harness} selected={selected} />
      </div>

      <div className="grid-2">
        <MemoryCard harness={harness} theme={theme} selected={selected} />
      </div>
      <BundleSections harness={harness} theme={theme} selected={selected} />
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
  const { text } = useI18n();
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
      <div className="card-title">{text("memory — GC'd heap holding 10k rows", '内存——持有 10k 行时 GC 后的堆')}</div>
      <div className="card-desc">
        {text(
          'Used JS heap per realm after creating 10,000 rows and forcing GC. Indicative (one scenario), but the BTS/MTS asymmetry shows where each framework keeps its state.',
          '创建 10,000 行并强制 GC 后，各 realm 使用的 JS 堆。它只代表一个场景，但 BTS/MTS 的不对称能显示各框架把状态保存在何处。',
        )}
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
                  <span
                    className={`bar-value${(r[k] ?? 0) / max > 0.72 ? ' inside' : ''}`}
                    style={{ left: `${((r[k] ?? 0) / max) * 100}%`, fontSize: '0.68rem' }}
                  >
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
  const { locale, text } = useI18n();
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
    ? endpointDetailLabel([...detailKinds][0], locale)
    : text('source-labelled samples (see row data)', '来源标记的样本（见行数据）');
  const tableRows = rows.flatMap((row) => Object.entries(row.endpoints)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 8)
    .map(([name, value], index) => ({ id: row.id, name, value, first: index === 0 })));

  if (!tableRows.length) return null;

  return (
    <details className="visualization-appendix">
      <summary>
        <span className="appendix-chevron" aria-hidden="true">›</span>
        <span className="appendix-name">
          <small>{text('Data appendix', '数据附录')}</small>
          <strong>{text('Endpoint traffic', 'Endpoint 流量')}</strong>
        </span>
        <span className="appendix-meta">
          {detailDescription} · {text(`${rows.filter((row) => Object.keys(row.endpoints).length).length} entries`, `${rows.filter((row) => Object.keys(row.endpoints).length).length} 个条目`)} · {text(`${tableRows.length} rows`, `${tableRows.length} 行`)}
        </span>
      </summary>
      <div className="visualization-appendix-body">
        <p>
          {text('Exact endpoint rows behind the wire bytes and messages charts.', 'wire 字节与消息图背后的精确 endpoint 行。')}{' '}
          <code>callLepusMethod</code> {text("carries most frameworks' render payloads;", '承载多数框架的渲染 payload；')}{' '}
          <code>publishEvent</code>/<code>publicComponentEvent</code> {text('carry input events up;', '向上传递输入事件；')}{' '}
          <code>markTiming</code>/<code>postTimingFlags</code> {text('are engine timing chatter.', '是引擎的计时通信。')}
        </p>
        <div className="appendix-table-scroll">
        <table>
          <thead>
            <tr><th>{text('entry', '条目')}</th><th>endpoint</th><th>{text('msgs', '消息')}</th><th>{text('bytes', '字节')}</th></tr>
          </thead>
          <tbody>
            {tableRows.map((row) => (
              <tr key={`${row.id}-${row.name}`}>
                <td>{row.first ? shortLabel(row.id) : ''}</td>
                <td>{row.name}</td>
                <td>{row.value.messages}</td>
                <td>{fmtBytes(row.value.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </details>
  );
}

function BundleSections({ harness, theme, selected }: { harness: string; theme: 'light' | 'dark'; selected: Set<string> }) {
  const { text } = useI18n();
  const { one } = useBenchmarkData();
  const { setTip, onMove, tipNode } = useTooltip();
  const rows = ENTRIES.filter((e) => selected.has(e.id)).map((e) => ({
    id: e.id,
    mts: one({ suite: 'bundle', harness, entry: e.id, metric: 'mtsSectionGzip' })?.median ?? null,
    bts: one({ suite: 'bundle', harness, entry: e.id, metric: 'btsSectionGzip' })?.median ?? null,
    whole: one({ suite: 'bundle', harness, entry: e.id, metric: 'bundleWebGzip' })?.median ?? null,
  }));
  if (!rows.some((row) => row.whole != null)) return null;
  const max = Math.max(1e-9, ...rows.map((r) => r.whole ?? 0)) * 1.08;

  return (
    <div className="card" onMouseMove={onMove}>
      <div className="card-title">{text('bundle split — MTS vs BTS program size (gzip)', 'bundle 拆分——MTS 与 BTS 程序体积（gzip）')}</div>
      <div className="card-desc">
        {text('How much code each thread must parse before it can work. JSON-format web bundles expose the split', '每个线程开始工作前必须解析多少代码。JSON 格式 web bundle 会暴露拆分：')}{' '}
        (<code>lepusCode.root</code> = {text('main thread', '主线程')}, <code>app-service.js</code> = {text('background', '后台')});{' '}
        {text('binary bundles report whole-bundle only (hatched).', '二进制 bundle 只报告整体体积（斜线填充）。')}
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
                    ? [`MTS ${fmtBytes(r.mts)} · BTS ${fmtBytes(r.bts)}`, text(`whole bundle ${fmtBytes(r.whole)}`, `完整 bundle ${fmtBytes(r.whole)}`)]
                    : [text(`whole bundle ${fmtBytes(r.whole)} (binary format — no section split)`, `完整 bundle ${fmtBytes(r.whole)}（二进制格式——无 section 拆分）`)],
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
              <span
                className={`bar-value${(r.whole ?? 0) / max > 0.72 ? ' inside' : ''}`}
                style={{ left: `${((r.whole ?? 0) / max) * 100}%` }}
              >
                {fmtBytes(r.whole)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'currentColor' }} /> MTS section</span>
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'currentColor', opacity: 0.45 }} /> BTS section</span>
        <span className="item" style={{ cursor: 'default' }}><span className="swatch" style={{ background: 'repeating-linear-gradient(45deg, currentColor, currentColor 3px, transparent 3px, transparent 6px)' }} /> {text('binary (no split)', '二进制（无拆分）')}</span>
      </div>
      {tipNode}
    </div>
  );
}
