import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  BENCHMARK_HISTORY,
  ENTRIES,
  entryColor,
  fmtBytes,
  fmtCount,
  fmtMs,
  fmtX,
  HistoryCheckpoint,
  HistoryRecord,
  historyRecordsForCheckpoint,
  shortLabel,
} from '../data';
import {
  completeHistoryAggregateCells,
  rankHistoryAggregate,
  rankHistoryCell,
} from '../derive.mjs';
import { useTooltip } from '../hooks';
import { INTERACTION_WORKLOADS, JS_FRAMEWORK_SCORE_OPS } from '../interaction-score';

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
    score: 'relative geomean',
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
  dataset: string;
  rank: number | null;
  plotRank: number;
  status: 'ranked' | 'missing' | 'observation' | 'dnf' | 'incomparable';
  record: HistoryRecord | null;
  aggregateRecords?: HistoryRecord[];
  aggregateValue?: number | null;
  aggregateCellCount?: number;
  checkpoint: HistoryCheckpoint;
  cohortIdentity: string;
  segment?: string;
}

function formatPointValue(point: RankedPoint): string {
  if (point.aggregateCellCount != null) {
    return point.aggregateValue == null ? 'incomplete matrix' : fmtX(point.aggregateValue);
  }
  return formatValue(point.record);
}

interface CohortTransition {
  entry: string;
  fromDataset: string;
  fromRank: number;
  toDataset: string;
  toRank: number;
}

function ChoiceRail({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{
    value: string;
    label: string;
    equation?: { head: string; lines: string[] };
  }>;
  onChange: (value: string) => void;
}) {
  const { setTip, onMove, place, tipNode } = useTooltip();
  return (
    <div className="history-choice-rail">
      <span className="history-choice-label">{label}</span>
      <div
        className="history-choice-scroll"
        role="group"
        aria-label={`History ${label}`}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0
            : event.key === 'End' ? buttons.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
          buttons[next]?.click();
        }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            aria-label={option.equation
              ? `${option.label}. ${option.equation.head}. ${option.equation.lines.join(' ')}`
              : option.label}
            tabIndex={option.value === value ? 0 : -1}
            onClick={() => onChange(option.value)}
            onMouseEnter={option.equation ? (event) => {
              setTip(option.equation!);
              onMove(event);
            } : undefined}
            onMouseMove={option.equation ? onMove : undefined}
            onMouseLeave={option.equation ? (event) => {
              if (document.activeElement !== event.currentTarget) setTip(null);
            } : undefined}
            onFocus={option.equation ? (event) => {
              setTip(option.equation!);
              const rect = event.currentTarget.getBoundingClientRect();
              requestAnimationFrame(() => place({
                clientX: rect.left + rect.width / 2,
                clientY: rect.bottom,
              }));
            } : undefined}
            onBlur={option.equation ? () => setTip(null) : undefined}
          >
            {option.label}
            {option.equation && <span className="history-choice-info" aria-hidden="true">?</span>}
          </button>
        ))}
      </div>
      {tipNode}
    </div>
  );
}

function workloadLabel(workload: string): string {
  const labels: Record<string, string> = {
    append1k: 'append 1k',
    update10th: 'update every 10th',
    updateStorm: 'update storm',
    selectStorm: 'select storm',
    memoryAfterClear: 'memory after clear',
  };
  return labels[workload] ?? workload;
}

const HISTORY_ENTRY_IDS = [...new Set(BENCHMARK_HISTORY.checkpoints.flatMap((checkpoint) =>
  checkpoint.harnesses.flatMap((cohort) => cohort.entryIds)))];
const HISTORY_RANK_LIMIT = Math.max(1, ...BENCHMARK_HISTORY.checkpoints.flatMap((checkpoint) =>
  checkpoint.harnesses.map((cohort) => cohort.entryIds.length)));
const DATASET_IDS = BENCHMARK_HISTORY.checkpoints.map((checkpoint) => checkpoint.id);
const DATASET_BY_ID = new Map(BENCHMARK_HISTORY.checkpoints.map((checkpoint) =>
  [checkpoint.id, checkpoint]));
const SCORE_VIEW = 'score';
const CELL_VIEW = 'cell';
type RankView = typeof SCORE_VIEW | typeof CELL_VIEW;

interface HistoryScoreMode {
  key: string;
  label: string;
  ops: Array<{ key: string; workload: string; scale: number }>;
  weights?: number[];
  adaptiveHistory: boolean;
  formulaLabel: string;
  equation: { head: string; lines: string[] };
}
const datasetAxisLabel = (id: string) => {
  const label = DATASET_BY_ID.get(id)?.label ?? id;
  return label.includes(' · ') ? label.slice(label.indexOf(' · ') + 3) : label;
};

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
  const focusSeriesRef = useRef<(entry: string | null) => void>(() => undefined);
  const allRecords = useMemo(() => BENCHMARK_HISTORY.records.filter((record) =>
    record.harness === harness && HISTORY_ENTRY_IDS.includes(record.entry)), [harness]);
  const rawWorkloads = [...new Set(allRecords
    .filter((record) => record.workload !== 'selectInitial')
    .map((record) => record.workload))].sort((a, b) => {
    const preferred = ['create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear', 'updateStorm', 'selectStorm', 'memory', 'startup'];
    return preferred.indexOf(a) - preferred.indexOf(b) || a.localeCompare(b);
  });
  const scoreModes = useMemo<HistoryScoreMode[]>(() => {
    const equalMode = (scale: number): HistoryScoreMode => {
      const ops = INTERACTION_WORKLOADS
        .map((workload) => ({ key: `${workload}@${scale}`, workload, scale }))
        .filter((op) => allRecords.some((record) => record.workload === op.workload
          && record.scale === op.scale && record.metric === 'latency'));
      return {
        key: `equal-${scale}`,
        label: `equal · ${scale / 1000}k`,
        ops,
        adaptiveHistory: true,
        formulaLabel: 'equal-weight geometric mean',
        equation: {
          head: `Equal-weight ${scale / 1000}k geometric mean`,
          lines: [
            'rᵢ = medianᵢ ÷ fastest medianᵢ',
            'score = exp(Σ ln(rᵢ) ÷ N)',
            'N = operations complete for every entry at that dataset',
            'A changed operation set is joined with a dashed bridge',
          ],
        },
      };
    };
    return [
      ...(harness === 'web' ? [{
        key: 'weighted',
        label: 'weighted · available',
        ops: JS_FRAMEWORK_SCORE_OPS.map(({ key, workload, scale }) => ({ key, workload, scale })),
        weights: JS_FRAMEWORK_SCORE_OPS.map((op) => op.weight),
        adaptiveHistory: true,
        formulaLabel: 'coverage-adjusted upstream-weight geometric mean',
        equation: {
          head: 'Available-cell upstream weights',
          lines: [
            'rᵢ = medianᵢ ÷ fastest medianᵢ',
            'score = exp(Σavailable wᵢ · ln(rᵢ) ÷ Σavailable wᵢ)',
            'A missing cell is omitted for every entry; remaining weights are renormalized',
            'A changed cell set is dashed; 9/9 is exact upstream coverage',
          ],
        },
      }] : []),
      equalMode(1000),
      equalMode(10000),
    ];
  }, [allRecords, harness]);
  const initialCase = param('historyCase');
  const [rankView, setRankView] = useState<RankView>(() =>
    param('historyView') === CELL_VIEW || (initialCase != null && initialCase !== 'interactive')
      ? CELL_VIEW : SCORE_VIEW);
  const [scoreModeKey, setScoreModeKey] = useState(() => {
    if (initialCase === 'interactive') {
      return Number(param('historyScale') ?? 1000) === 10000 ? 'equal-10000' : 'equal-1000';
    }
    return param('historyScore') ?? 'weighted';
  });
  const activeScoreMode = scoreModes.find((mode) => mode.key === scoreModeKey) ?? scoreModes[0];
  const workloads = rawWorkloads;
  const [workload, setWorkload] = useState(() => param('historyCase') ?? 'create');
  const activeWorkload = workloads.includes(workload) ? workload : (workloads[0] ?? 'create');
  const isAggregate = rankView === SCORE_VIEW;
  const metrics = [...new Set(allRecords
    .filter((record) => record.workload === activeWorkload)
    .map((record) => record.metric))].sort((a, b) =>
    (a === 'latency' ? -1 : b === 'latency' ? 1 : a.localeCompare(b)));
  const [metric, setMetric] = useState(() => param('historyMetric') ?? 'latency');
  const activeMetric = metrics.includes(metric) ? metric : (metrics[0] ?? 'latency');
  const scales = [...new Set(allRecords.filter((record) => record.workload === activeWorkload
    && record.metric === activeMetric).map((record) => record.scale))].sort((a, b) => a - b);
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
      const checkpointRecords = historyRecordsForCheckpoint(checkpoint)
        .filter((record) => record.harness === harness) as HistoryRecord[];
      const requestedAggregateCells = activeScoreMode?.ops.map((op) => ({
        key: op.key,
        records: checkpointRecords.filter((record) => record.workload === op.workload
          && record.scale === op.scale && record.metric === 'latency'),
      })) ?? [];
      const availableAggregateCells = activeScoreMode?.adaptiveHistory
        ? completeHistoryAggregateCells(cohort.entryIds, requestedAggregateCells)
        : requestedAggregateCells;
      const aggregateCells = availableAggregateCells;
      const weightByCell = new Map(activeScoreMode?.ops.map((op, index) => [
        op.key,
        activeScoreMode.weights?.[index],
      ]) ?? []);
      const aggregateWeights = activeScoreMode?.weights
        ? aggregateCells.map((cell) => weightByCell.get(cell.key)!)
        : undefined;
      const ranked = isAggregate && activeScoreMode
        ? rankHistoryAggregate(
          cohort.entryIds,
          aggregateCells,
          cohort.rankEligible,
          aggregateWeights,
        ).map((point) => ({
          entry: point.entry,
          record: null,
          aggregateRecords: point.records,
          aggregateValue: point.value,
          aggregateCellCount: point.cellCount,
          rank: point.rank,
          status: point.status,
        }))
        : rankHistoryCell(cohort.entryIds, checkpointRecords.filter((record) =>
          record.workload === activeWorkload
          && record.scale === activeScale
          && record.metric === activeMetric), cohort.rankEligible) as Array<{
          entry: string; record: HistoryRecord | null; rank: number | null;
          status: RankedPoint['status'];
        }>;
      const formulaIdentity = isAggregate
        ? `${activeScoreMode?.key}:${aggregateCells.map((cell) => cell.key).join(',')}`
        : 'single-cell';
      const cohortIdentity = [
        cohort.machineId,
        cohort.environment,
        ...cohort.entryIds,
        formulaIdentity,
      ].join('|');
      for (const point of ranked) {
        out.push({
          ...point,
          label: shortLabel(point.entry),
          dataset: checkpoint.id,
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
  }, [harness, activeWorkload, activeScale, activeMetric, isAggregate, activeScoreMode]);

  const selectedCheckpoint = BENCHMARK_HISTORY.checkpoints[snapshotIndex];
  const selectedPoints = points.filter((point) => point.checkpoint.id === selectedCheckpoint.id);
  const selectedAggregateCellCount = selectedPoints.find((point) =>
    point.aggregateCellCount != null)?.aggregateCellCount;
  const rankedPoints = points.filter((point) => point.status === 'ranked');
  const observations = points.filter((point) => point.status === 'observation');
  const incomparable = points.filter((point) => point.status === 'incomparable');
  const dnfs = points.filter((point) => point.status === 'dnf');
  const missing = points.filter((point) => point.status === 'missing');
  const transitions = useMemo(() => {
    const out: CohortTransition[] = [];
    const order = new Map(DATASET_IDS.map((id, index) => [id, index]));
    for (const entry of HISTORY_ENTRY_IDS) {
      const ranked = points.filter((point) => point.entry === entry && point.status === 'ranked')
        .sort((a, b) => (order.get(a.dataset) ?? 0) - (order.get(b.dataset) ?? 0));
      for (let index = 1; index < ranked.length; index += 1) {
        const previous = ranked[index - 1];
        const current = ranked[index];
        if ((order.get(current.dataset) ?? 0) !== (order.get(previous.dataset) ?? 0) + 1) continue;
        if (previous.cohortIdentity === current.cohortIdentity) continue;
        out.push({
          entry,
          fromDataset: previous.dataset,
          fromRank: previous.rank!,
          toDataset: current.dataset,
          toRank: current.rank!,
        });
      }
    }
    return out;
  }, [points]);

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
      return [
        point.label,
        `${status}  ·  ${formatPointValue(point)}`,
        datasetAxisLabel(point.checkpoint.id),
        point.aggregateCellCount != null
          ? `${point.aggregateCellCount}/${activeScoreMode?.ops.length ?? point.aggregateCellCount} available cells  ·  ${activeScoreMode?.formulaLabel ?? 'geometric mean'}`
          : record ? `${record.boundary}  ·  n=${record.n}${record.dnfCount ? `  ·  ${record.dnfCount} DNF` : ''}` : point.checkpoint.description,
      ].filter(Boolean).join('\n');
    };
    const width = Math.max(760, node.clientWidth || 760);
    const plot = Plot.plot({
      width,
      height: 390,
      marginLeft: 52,
      marginRight: 18,
      marginBottom: 64,
      style: { background: 'transparent', color: fg, fontSize: '11px' },
      x: {
        label: 'dataset sequence →',
        type: 'point',
        domain: DATASET_IDS,
        tickFormat: datasetAxisLabel,
        grid: true,
        padding: 0.45,
      },
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
        Plot.ruleX([selectedCheckpoint.id], { stroke: 'var(--accent)', strokeWidth: 14, strokeOpacity: 0.08 }),
        Plot.ruleX([selectedCheckpoint.id], { stroke: 'var(--accent)', strokeWidth: 1.5, strokeOpacity: 0.9 }),
        Plot.line(rankedPoints, {
          x: 'dataset', y: 'rank', z: 'segment', stroke: 'entry', strokeWidth: 2,
          className: 'history-series history-series-line',
        }),
        Plot.link(transitions, {
          x1: 'fromDataset', y1: 'fromRank', x2: 'toDataset', y2: 'toRank',
          stroke: 'entry', strokeWidth: 2, strokeDasharray: '5,4', strokeOpacity: 0.72,
          className: 'history-series history-series-line',
        }),
        Plot.dot(rankedPoints, {
          x: 'dataset', y: 'rank', stroke: 'entry', fill: background, r: 4, strokeWidth: 2,
          className: 'history-series history-series-point',
        }),
        Plot.dot(observations, {
          x: 'dataset', y: 'plotRank', stroke: 'entry', fill: background, r: 4, strokeWidth: 1.5,
          className: 'history-series history-series-point',
        }),
        Plot.dot(incomparable, {
          x: 'dataset', y: 'plotRank', stroke: 'entry', fill: 'entry', r: 4, opacity: 0.8,
          className: 'history-series history-series-point',
        }),
        Plot.dot(dnfs, { x: 'dataset', y: 'plotRank', stroke: 'var(--bad)', fill: 'var(--bad)', r: 3 }),
        Plot.dot(missing, { x: 'dataset', y: 'plotRank', fill: 'entry', r: 1.4, opacity: 0.18 }),
        Plot.dot(selectedPoints.filter((point) => point.status === 'ranked'), {
          x: 'dataset', y: 'rank', stroke: 'var(--accent)', fill: 'none', r: 7, strokeWidth: 2,
        }),
        Plot.text(selectedPoints.filter((point) => point.status === 'ranked'), {
          x: 'dataset',
          y: 'rank',
          text: (point: RankedPoint) => `${point.label}  ${formatPointValue(point)}`,
          dx: snapshotIndex >= DATASET_IDS.length - 2 ? -12 : 12,
          textAnchor: snapshotIndex >= DATASET_IDS.length - 2 ? 'end' : 'start',
          fill: 'entry',
          stroke: background,
          strokeWidth: 4,
          paintOrder: 'stroke',
          fontWeight: 700,
          fontSize: 11,
          className: 'history-series history-series-label',
        }),
        Plot.tip(points, Plot.pointer({
          x: 'dataset', y: 'plotRank', title,
          fill: theme === 'dark' ? '#252831' : '#fffdf8',
          stroke: theme === 'dark' ? '#5b5e68' : '#bbb8ad',
          strokeWidth: 1,
          fontSize: 12,
          fontWeight: 550,
          lineHeight: 1.3,
          lineWidth: 28,
          textPadding: 11,
          pointerSize: 8,
          pathFilter: 'drop-shadow(0 8px 20px rgba(0,0,0,0.24))',
        })),
      ],
    });
    node.replaceChildren(plot);
    const entryByColor = new Map(ids.map((id) => [entryColor(id, theme).toLowerCase(), id]));
    const seriesMarks = [...plot.querySelectorAll<SVGElement>(
      '.history-series path, .history-series circle, .history-series text',
    )];
    const entryForMark = (mark: SVGElement) => {
      const stroke = mark.getAttribute('stroke')?.toLowerCase();
      const fill = mark.getAttribute('fill')?.toLowerCase();
      return (stroke && entryByColor.get(stroke)) || (fill && entryByColor.get(fill)) || null;
    };
    const focusSeries = (entry: string | null) => {
      for (const mark of seriesMarks) {
        const markEntry = entryForMark(mark);
        mark.classList.toggle('is-series-muted', Boolean(entry && markEntry && markEntry !== entry));
        mark.classList.toggle('is-series-focus', Boolean(entry && markEntry === entry));
      }
      const section = node.closest('.history-ranking');
      for (const item of section?.querySelectorAll<HTMLElement>('[data-history-entry]') ?? []) {
        const itemEntry = item.dataset.historyEntry;
        item.classList.toggle('is-series-muted', Boolean(entry && itemEntry !== entry));
        item.classList.toggle('is-series-focus', Boolean(entry && itemEntry === entry));
      }
    };
    const controller = new AbortController();
    for (const mark of seriesMarks) {
      const entry = entryForMark(mark);
      if (!entry) continue;
      mark.addEventListener('pointerenter', () => focusSeries(entry), { signal: controller.signal });
    }
    plot.addEventListener('pointerleave', () => focusSeries(null), { signal: controller.signal });
    focusSeriesRef.current = focusSeries;
    return () => {
      controller.abort();
      focusSeriesRef.current = () => undefined;
      plot.remove();
    };
  }, [points, rankedPoints, observations, incomparable, dnfs, missing, transitions, selectedPoints,
    selectedCheckpoint, snapshotIndex, activeScale, harness, theme]);

  const changeRankView = (value: string) => {
    const next = value === CELL_VIEW ? CELL_VIEW : SCORE_VIEW;
    setRankView(next);
    syncParam('historyView', next === SCORE_VIEW ? null : next);
  };
  const changeScoreMode = (value: string) => {
    setScoreModeKey(value);
    syncParam('historyScore', value === 'weighted' ? null : value);
  };
  const changeWorkload = (value: string) => { setWorkload(value); syncParam('historyCase', value === 'create' ? null : value); };
  const changeMetric = (value: string) => { setMetric(value); syncParam('historyMetric', value === 'latency' ? null : value); };
  const changeScale = (value: number) => { setScale(value); syncParam('historyScale', value === 1000 ? null : String(value)); };

  return (
    <section className="history-ranking" aria-labelledby="history-ranking-title">
      <div className="history-heading">
        <div>
          <div className="history-kicker">Exact-source history</div>
          <h2 id="history-ranking-title">Rank by dataset</h2>
          <p>
            Each node is one retained dataset. Solid lines share one comparison cohort; dashed
            bridges preserve the framework story across a cohort or formula-set change. Composite
            history omits a missing cell for every entry together, then recomputes over that dataset's
            largest complete common matrix. Single measurement exposes the raw case, scale, and metric.
          </p>
        </div>
      </div>
      <div className="history-browser" aria-label="Browse ranking configuration">
        <div className="history-browser-heading">
          <span>Browse configuration</span>
          <output>{isAggregate && activeScoreMode
            ? `${activeScoreMode.label} · ${selectedAggregateCellCount ?? 0}/${activeScoreMode.ops.length} cells · relative geomean`
            : `${workloadLabel(activeWorkload)} · ${activeScale?.toLocaleString()} rows · ${metricLabel(activeMetric)}`}</output>
        </div>
        <ChoiceRail
          label="Lynx for"
          value={harness}
          options={[{ value: 'web', label: 'Web' }, { value: 'native', label: 'Native' }]}
          onChange={onHarnessChange}
        />
        <ChoiceRail
          label="Rank"
          value={rankView}
          options={[
            { value: SCORE_VIEW, label: 'Composite score' },
            { value: CELL_VIEW, label: 'Single measurement' },
          ]}
          onChange={changeRankView}
        />
        {isAggregate && activeScoreMode ? (
          <ChoiceRail
            label="Formula"
            value={activeScoreMode.key}
            options={scoreModes.map((mode) => ({
              value: mode.key,
              label: mode.label,
              equation: mode.equation,
            }))}
            onChange={changeScoreMode}
          />
        ) : (
          <>
            <ChoiceRail
              label="Case"
              value={activeWorkload}
              options={workloads.map((value) => ({ value, label: workloadLabel(value) }))}
              onChange={changeWorkload}
            />
            <ChoiceRail
              label="Scale"
              value={String(activeScale)}
              options={scales.map((value) => ({ value: String(value), label: `${value.toLocaleString()} rows` }))}
              onChange={(value) => changeScale(Number(value))}
            />
            <ChoiceRail
              label="Metric"
              value={activeMetric}
              options={metrics.map((value) => ({ value, label: metricLabel(value) }))}
              onChange={changeMetric}
            />
          </>
        )}
      </div>
      <div className="history-legend" aria-label="Framework colors">
        {ENTRIES.filter((entry) => HISTORY_ENTRY_IDS.includes(entry.id)).map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-history-entry={entry.id}
            onPointerEnter={() => focusSeriesRef.current(entry.id)}
            onPointerLeave={(event) => {
              if (document.activeElement !== event.currentTarget) focusSeriesRef.current(null);
            }}
            onFocus={() => focusSeriesRef.current(entry.id)}
            onBlur={() => focusSeriesRef.current(null)}
            aria-label={`Highlight ${shortLabel(entry.id)}`}
          >
            <i style={{ background: entryColor(entry.id, theme) }} />{shortLabel(entry.id)}
          </button>
        ))}
        <span className="history-status">– – cohort/formula change · ○ observation · ● incomparable · red DNF · faint missing</span>
      </div>
      <div className="history-plot" ref={ref} />
      <details className="history-evidence">
        <summary>Source evidence and gaps ({BENCHMARK_HISTORY.sources.length} audited runs)</summary>
        <div className="history-evidence-scroll">
          <table>
            <thead><tr><th>dataset</th><th>framework</th><th>rank</th><th>value</th><th>source / provenance</th></tr></thead>
            <tbody>
              {points.map((point) => (
                <tr key={`${point.checkpoint.id}:${point.entry}`}>
                  <td><button type="button" onClick={() => onSnapshotChange(BENCHMARK_HISTORY.checkpoints.indexOf(point.checkpoint))}>{point.checkpoint.label}</button></td>
                  <td>{point.label}</td><td>{point.rank == null ? point.status : `#${point.rank}`}</td>
                  <td>{formatPointValue(point)}{point.aggregateCellCount != null
                    ? ` · ${point.aggregateCellCount}/${activeScoreMode?.ops.length ?? point.aggregateCellCount} cells`
                    : ''}</td>
                  <td><code>{point.record?.runFile
                    ?? point.aggregateRecords?.[0]?.runFile
                    ?? point.checkpoint.description}</code>{point.record?.entryCommit
                    ? ` @ ${point.record.entryCommit.slice(0, 12)}`
                    : point.aggregateRecords?.[0]?.entryCommit
                      ? ` @ ${point.aggregateRecords[0].entryCommit.slice(0, 12)}`
                      : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
