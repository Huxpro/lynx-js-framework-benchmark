import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  BENCHMARK_HISTORY,
  ENTRIES,
  entryColor,
  fmtBytes,
  fmtCount,
  fmtMs,
  HistoryCheckpoint,
  HistoryRecord,
  historyRecordsForCheckpoint,
  shortLabel,
} from '../data';
import { rankHistoryCell } from '../derive.mjs';

const param = (name: string) => new URLSearchParams(location.search).get(name);

function syncParam(name: string, value: string | null) {
  const params = new URLSearchParams(location.search);
  if (value == null) params.delete(name);
  else params.set(name, value);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function formatValue(record: HistoryRecord | null): string {
  if (record?.median == null) return record?.dnfCount ? `DNF (${record.dnfCount})` : 'missing';
  if (record.unit === 'ms') return fmtMs(record.median);
  if (record.unit === 'bytes') return fmtBytes(record.median);
  if (record.unit === 'count') return fmtCount(record.median);
  return `${record.median.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${record.unit}`;
}

function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    latency: 'wall latency', fcp: 'first contentful paint', settled: 'settled',
    btsCpu: 'BTS CPU', mtsCpu: 'MTS CPU', wireToMtsBytes: 'BTS→MTS bytes',
    wireToBtsBytes: 'MTS→BTS bytes', wireToMtsMsgs: 'BTS→MTS messages',
    wireToBtsMsgs: 'MTS→BTS messages', heapBts: 'BTS heap', heapMts: 'MTS heap',
    octaneCommitAck: 'Octane commit ACK', octaneSecondFrame: 'Octane second frame',
  };
  return labels[metric] ?? metric;
}

interface RankedPoint {
  entry: string;
  label: string;
  time: Date;
  rank: number | null;
  plotRank: number;
  status: 'ranked' | 'missing' | 'observation' | 'dnf' | 'incomparable';
  record: HistoryRecord | null;
  checkpoint: HistoryCheckpoint;
  cohortIdentity: string;
  segment?: string;
}

const HISTORY_ENTRY_IDS = [...new Set(BENCHMARK_HISTORY.checkpoints.flatMap((checkpoint) =>
  checkpoint.harnesses.flatMap((cohort) => cohort.entryIds)))];
const HISTORY_RANK_LIMIT = Math.max(1, ...BENCHMARK_HISTORY.checkpoints.flatMap((checkpoint) =>
  checkpoint.harnesses.map((cohort) => cohort.entryIds.length)));

export function HistoryRanking({
  harness,
  onHarnessChange,
  theme,
  snapshotIndex,
  onSnapshotChange,
}: {
  harness: string;
  onHarnessChange: (harness: string) => void;
  theme: 'light' | 'dark';
  snapshotIndex: number;
  onSnapshotChange: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const allRecords = BENCHMARK_HISTORY.records.filter((record) =>
    record.harness === harness && HISTORY_ENTRY_IDS.includes(record.entry));
  const workloads = [...new Set(allRecords.map((record) => record.workload))].sort((a, b) => {
    const preferred = ['create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear', 'updateStorm', 'selectStorm', 'memory', 'startup'];
    return preferred.indexOf(a) - preferred.indexOf(b) || a.localeCompare(b);
  });
  const [workload, setWorkload] = useState(() => param('historyCase') ?? 'create');
  const activeWorkload = workloads.includes(workload) ? workload : (workloads[0] ?? 'create');
  const metrics = [...new Set(allRecords.filter((record) => record.workload === activeWorkload)
    .map((record) => record.metric))].sort((a, b) =>
    (a === 'latency' ? -1 : b === 'latency' ? 1 : a.localeCompare(b)));
  const [metric, setMetric] = useState(() => param('historyMetric') ?? 'latency');
  const activeMetric = metrics.includes(metric) ? metric : (metrics[0] ?? 'latency');
  const scales = [...new Set(allRecords.filter((record) =>
    record.workload === activeWorkload && record.metric === activeMetric).map((record) => record.scale))]
    .sort((a, b) => a - b);
  const [scale, setScale] = useState(() => Number(param('historyScale') ?? 1000));
  const activeScale = scales.includes(scale) ? scale : (scales.includes(1000) ? 1000 : scales[0]);

  useEffect(() => {
    if (activeWorkload !== workload) setWorkload(activeWorkload);
    if (activeMetric !== metric) setMetric(activeMetric);
    if (activeScale != null && activeScale !== scale) setScale(activeScale);
  }, [activeWorkload, workload, activeMetric, metric, activeScale, scale]);

  const points = useMemo(() => {
    const out: RankedPoint[] = [];
    for (const [index, checkpoint] of BENCHMARK_HISTORY.checkpoints.entries()) {
      const cohort = checkpoint.harnesses.find((candidate) => candidate.harness === harness);
      if (!cohort) continue;
      const records = historyRecordsForCheckpoint(checkpoint).filter((record) =>
        record.harness === harness
        && record.workload === activeWorkload
        && record.scale === activeScale
        && record.metric === activeMetric) as HistoryRecord[];
      const ranked = rankHistoryCell(cohort.entryIds, records, cohort.rankEligible) as Array<{
        entry: string; record: HistoryRecord | null; rank: number | null;
        status: RankedPoint['status'];
      }>;
      const cohortIdentity = [cohort.machineId, cohort.environment, ...cohort.entryIds].join('|');
      for (const point of ranked) {
        out.push({
          ...point,
          label: shortLabel(point.entry),
          time: new Date(checkpoint.generatedAt),
          plotRank: point.rank ?? HISTORY_RANK_LIMIT + 1,
          checkpoint,
          cohortIdentity,
        });
      }
    }
    for (const entry of HISTORY_ENTRY_IDS) {
      let segment = 0;
      let previousIdentity: string | null = null;
      for (const point of out.filter((candidate) => candidate.entry === entry)) {
        if (point.status !== 'ranked' || previousIdentity !== point.cohortIdentity) segment += 1;
        if (point.status === 'ranked') point.segment = `${entry}:${segment}`;
        previousIdentity = point.status === 'ranked' ? point.cohortIdentity : null;
      }
    }
    return out;
  }, [harness, activeWorkload, activeScale, activeMetric]);

  const selectedCheckpoint = BENCHMARK_HISTORY.checkpoints[snapshotIndex];
  const selectedPoints = points.filter((point) => point.checkpoint.id === selectedCheckpoint.id);
  const rankedPoints = points.filter((point) => point.status === 'ranked');
  const observations = points.filter((point) => point.status === 'observation');
  const incomparable = points.filter((point) => point.status === 'incomparable');
  const dnfs = points.filter((point) => point.status === 'dnf');
  const missing = points.filter((point) => point.status === 'missing');

  useEffect(() => {
    const node = ref.current;
    if (!node || activeScale == null || points.length === 0) return;
    const ids = HISTORY_ENTRY_IDS;
    const fg = theme === 'dark' ? '#b5b4ab' : '#5f5e57';
    const background = theme === 'dark' ? '#1d1f26' : '#ffffff';
    const statusRank = HISTORY_RANK_LIMIT + 1;
    const title = (point: RankedPoint) => {
      const record = point.record;
      const status = point.status === 'ranked' ? `rank ${point.rank} of ${point.checkpoint.harnesses
        .find((cohort) => cohort.harness === harness)?.entryIds.length ?? '?'}`
        : point.status === 'incomparable' ? 'not ranked — incomparable transport work'
          : point.status === 'observation' ? 'not ranked — isolated observation'
            : point.status === 'dnf' ? 'not ranked — DNF' : 'not run in this exact cohort';
      const transport = record?.transport;
      return [
        `${point.label} — ${status}`,
        `${point.checkpoint.generatedAt.slice(0, 10)} · ${formatValue(record)}`,
        record ? `source ${record.runFile}` : point.checkpoint.description,
        record ? `commit ${record.entryCommit?.slice(0, 12) ?? 'unknown'} · machine ${record.machineId}` : '',
        record ? `${record.boundary} · n=${record.n}${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}` : '',
        transport ? `transport ${transport.toMtsMessages ?? '?'} BTS→MTS / ${transport.toBtsMessages ?? '?'} MTS→BTS; expected ≥${transport.expectedSequentialCommits}` : '',
      ].filter(Boolean).join('\n');
    };
    const width = Math.max(760, node.clientWidth || 760);
    const plot = Plot.plot({
      width,
      height: 390,
      marginLeft: 52,
      marginRight: 18,
      marginBottom: 56,
      style: { background: 'transparent', color: fg, fontSize: '11px' },
      x: { label: 'exact source time →', type: 'utc', grid: true, ticks: Math.min(8, points.length / 2) },
      y: {
        label: 'rank (lower is better)',
        domain: [1, statusRank],
        reverse: true,
        ticks: statusRank,
        tickFormat: (value: number) => value === statusRank ? 'gap' : `#${value}`,
        grid: true,
      },
      color: { domain: ids, range: ids.map((id) => entryColor(id, theme)) },
      marks: [
        Plot.ruleX([new Date(selectedCheckpoint.generatedAt)], { stroke: 'var(--accent)', strokeWidth: 2, strokeOpacity: 0.8 }),
        Plot.line(rankedPoints, { x: 'time', y: 'rank', z: 'segment', stroke: 'entry', strokeWidth: 2 }),
        Plot.dot(rankedPoints, { x: 'time', y: 'rank', stroke: 'entry', fill: background, r: 4, strokeWidth: 2 }),
        Plot.dot(observations, { x: 'time', y: 'plotRank', stroke: 'entry', fill: background, r: 4, strokeWidth: 1.5 }),
        Plot.dot(incomparable, { x: 'time', y: 'plotRank', stroke: 'entry', fill: 'entry', r: 4, opacity: 0.8 }),
        Plot.dot(dnfs, { x: 'time', y: 'plotRank', stroke: 'var(--bad)', fill: 'var(--bad)', r: 3 }),
        Plot.dot(missing, { x: 'time', y: 'plotRank', fill: 'entry', r: 1.4, opacity: 0.18 }),
        Plot.dot(selectedPoints.filter((point) => point.status === 'ranked'), {
          x: 'time', y: 'rank', stroke: 'var(--accent)', fill: 'none', r: 7, strokeWidth: 2,
        }),
        Plot.tip(points, Plot.pointer({ x: 'time', y: 'plotRank', title })),
      ],
    });
    node.replaceChildren(plot);
    return () => plot.remove();
  }, [points, rankedPoints, observations, incomparable, dnfs, missing, selectedPoints,
    selectedCheckpoint, activeScale, harness, theme]);

  const changeWorkload = (value: string) => { setWorkload(value); syncParam('historyCase', value === 'create' ? null : value); };
  const changeMetric = (value: string) => { setMetric(value); syncParam('historyMetric', value === 'latency' ? null : value); };
  const changeScale = (value: number) => { setScale(value); syncParam('historyScale', value === 1000 ? null : String(value)); };
  const selectedRanked = selectedPoints.filter((point) => point.status === 'ranked')
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  return (
    <section className="history-ranking" aria-labelledby="history-ranking-title">
      <div className="history-heading">
        <div>
          <div className="history-kicker">Exact-source history</div>
          <h2 id="history-ranking-title">Rank over time</h2>
          <p>Each rank is computed only inside one exact run or identity-matched Native cohort. Lines break when the machine, method cohort, or eligible framework set changes.</p>
        </div>
        <div className="history-selected" aria-live="polite">
          <span>selected</span>
          <strong>{new Date(selectedCheckpoint.generatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
          {selectedRanked.length ? selectedRanked.map((point) => `#${point.rank} ${point.label}`).join(' · ') : `no comparable ${harness} rank for this cell`}
        </div>
      </div>
      <div className="history-controls">
        <div className="seg" role="group" aria-label="History harness">
          {['web', 'native'].map((value) => (
            <button key={value} aria-pressed={harness === value} onClick={() => onHarnessChange(value)}>
              {value === 'web' ? 'Lynx for Web' : 'Native engine'}
            </button>
          ))}
        </div>
        <label>case<select aria-label="History case" value={activeWorkload} onChange={(event) => changeWorkload(event.target.value)}>
          {workloads.map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label>scale<select aria-label="History scale" value={activeScale} onChange={(event) => changeScale(Number(event.target.value))}>
          {scales.map((value) => <option key={value} value={value}>{value.toLocaleString()} rows</option>)}
        </select></label>
        <label>metric<select aria-label="History metric" value={activeMetric} onChange={(event) => changeMetric(event.target.value)}>
          {metrics.map((value) => <option key={value} value={value}>{metricLabel(value)}</option>)}
        </select></label>
      </div>
      <div className="history-legend" aria-label="Framework colors">
        {ENTRIES.filter((entry) => HISTORY_ENTRY_IDS.includes(entry.id)).map((entry) => (
          <span key={entry.id}><i style={{ background: entryColor(entry.id, theme) }} />{shortLabel(entry.id)}</span>
        ))}
        <span className="history-status">○ observation · ● incomparable · red DNF · faint dot missing</span>
      </div>
      <div className="history-plot" ref={ref} />
      <details className="history-evidence">
        <summary>Source evidence and gaps ({BENCHMARK_HISTORY.sources.length} audited runs)</summary>
        <div className="history-evidence-scroll">
          <table>
            <thead><tr><th>time</th><th>framework</th><th>rank</th><th>value</th><th>source / provenance</th></tr></thead>
            <tbody>
              {points.map((point) => (
                <tr key={`${point.checkpoint.id}:${point.entry}`}>
                  <td><button type="button" onClick={() => onSnapshotChange(BENCHMARK_HISTORY.checkpoints.indexOf(point.checkpoint))}>{point.checkpoint.generatedAt.replace('T', ' ').slice(0, 16)}</button></td>
                  <td>{point.label}</td><td>{point.rank == null ? point.status : `#${point.rank}`}</td>
                  <td>{formatValue(point.record)}</td>
                  <td><code>{point.record?.runFile ?? point.checkpoint.description}</code>{point.record?.entryCommit ? ` @ ${point.record.entryCommit.slice(0, 12)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
