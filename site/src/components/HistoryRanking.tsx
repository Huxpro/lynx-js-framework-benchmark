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
  HistoryReplay,
  WebRegime,
  historyReplayRecordsForCheckpoint,
  historyRecordsForCheckpoint,
  shortLabel,
} from '../data';
import {
  completeHistoryAggregateCells,
  rankHistoryAggregate,
  rankHistoryCell,
} from '../derive.mjs';
import { useElementWidth, useMediaQuery, useTooltip } from '../hooks';
import {
  localizedCheckpoint,
  localizedWorkload,
  Locale,
  useI18n,
} from '../i18n';
import { INTERACTION_WORKLOADS, JS_FRAMEWORK_SCORE_OPS } from '../interaction-score';
import { ResponsiveCopy } from './ResponsiveCopy';

const param = (name: string) => new URLSearchParams(location.search).get(name);

function syncParam(name: string, value: string | null) {
  const params = new URLSearchParams(location.search);
  if (value == null) params.delete(name);
  else params.set(name, value);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function formatValue(record: HistoryRecord | null, locale: Locale): string {
  if (record?.median == null) return record?.dnfCount
    ? `DNF (${record.dnfCount})`
    : locale === 'zh-CN' ? '缺失' : 'missing';
  if (record.unit === 'ms') return fmtMs(record.median);
  if (record.unit === 'bytes') return fmtBytes(record.median);
  if (record.unit === 'count') return fmtCount(record.median);
  return `${record.median.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${record.unit}`;
}

function metricLabel(metric: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    score: ['relative geomean', '相对几何平均'],
    latency: ['wall latency', '墙钟延迟'], fcp: ['first contentful paint', '首次内容绘制'], settled: ['settled', '稳定'],
    btsCpu: ['BTS CPU', 'BTS CPU'], mtsCpu: ['MTS CPU', 'MTS CPU'], wireToMtsBytes: ['BTS→MTS bytes', 'BTS→MTS 字节'],
    wireToBtsBytes: ['MTS→BTS bytes', 'MTS→BTS 字节'], wireToMtsMsgs: ['BTS→MTS messages', 'BTS→MTS 消息'],
    wireToBtsMsgs: ['MTS→BTS messages', 'MTS→BTS 消息'], heapBts: ['BTS heap', 'BTS 堆'], heapMts: ['MTS heap', 'MTS 堆'],
    octaneCommitAck: ['Octane commit ACK', 'Octane 提交 ACK'], octaneSecondFrame: ['Octane second frame', 'Octane 第二帧'],
  };
  return labels[metric]?.[locale === 'zh-CN' ? 1 : 0] ?? metric;
}

function rankDeltaGlyph(delta: number | null | undefined): string {
  if (delta == null || delta === 0) return '';
  return delta > 0 ? `↑${delta}` : `↓${Math.abs(delta)}`;
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
  machineId: string;
  aggregateCellKeys?: string[];
  segment?: string;
  previousRank?: number | null;
  rankDelta?: number | null;
}

function formatPointValue(point: RankedPoint, locale: Locale): string {
  if (point.aggregateCellCount != null) {
    return point.aggregateValue == null
      ? locale === 'zh-CN' ? '矩阵不完整' : 'incomplete matrix'
      : fmtX(point.aggregateValue);
  }
  return formatValue(point.record, locale);
}

interface CohortTransition {
  entry: string;
  fromDataset: string;
  fromRank: number;
  toDataset: string;
  toRank: number;
}

interface EntrySourceChange {
  entry: string;
  kind: 'added' | 'removed' | 'changed';
  from: string | null;
  to: string | null;
}

interface DatasetChangeAudit {
  checkpoint: HistoryCheckpoint;
  baseline: boolean;
  sourceChanges: EntrySourceChange[];
  cohortAdded: string[];
  cohortRemoved: string[];
  formulaAdded: string[];
  formulaRemoved: string[];
  machineChanged: boolean;
  previousMachineId: string | null;
  machineId: string;
  hasChanges: boolean;
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
    disabled?: boolean;
  }>;
  onChange: (value: string) => void;
}) {
  const { text } = useI18n();
  const { setTip, onMove, place, tipNode } = useTooltip();
  return (
    <div className="history-choice-rail">
      <span className="history-choice-label">{label}</span>
      <div
        className="history-choice-scroll"
        role="group"
        aria-label={text(`History ${label}`, `历史 ${label}`)}
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
            disabled={option.disabled}
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
const REPLAY_BASIS = 'replay';
const ORIGINAL_BASIS = 'original';
type HistoryBasis = typeof REPLAY_BASIS | typeof ORIGINAL_BASIS;
const WEB_HISTORY_REPLAY: HistoryReplay | null = BENCHMARK_HISTORY.replays?.find((replay) =>
  replay.id === 'web-history-replay-v1') ?? null;

interface HistoryScoreMode {
  key: string;
  label: string;
  ops: Array<{ key: string; workload: string; scale: number }>;
  weights?: number[];
  adaptiveHistory: boolean;
  formulaLabel: string;
  equation: { head: string; lines: string[] };
}
const datasetAxisLabel = (id: string, locale: Locale) => {
  const checkpoint = DATASET_BY_ID.get(id);
  const label = checkpoint ? localizedCheckpoint(checkpoint, locale).label : id;
  return label.includes(' · ') ? label.slice(label.indexOf(' · ') + 3) : label;
};

export function HistoryRanking({
  harness,
  regime,
  onHarnessChange,
  theme,
  snapshotIndex,
  onSnapshotChange,
}: {
  harness: string;
  regime: WebRegime;
  onHarnessChange: (harness: string) => void;
  theme: 'light' | 'dark';
  snapshotIndex: number;
  onSnapshotChange: (index: number) => void;
}) {
  const { locale, text } = useI18n();
  const compact = useMediaQuery('(max-width: 48rem)');
  const ref = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(ref);
  const focusSeriesRef = useRef<(entry: string | null) => void>(() => undefined);
  const matchesRegime = (record: HistoryRecord) => harness !== 'web'
    || (record.jsRegime === regime.jsRegime && record.jsFlags === regime.jsFlags
      && record.cpuThrottle === regime.cpuThrottle);
  const matchesCohort = (cohort: HistoryCheckpoint['harnesses'][number]) =>
    cohort.harness === harness && (harness !== 'web'
      || (cohort.jsRegime === regime.jsRegime && cohort.jsFlags === regime.jsFlags
        && cohort.cpuThrottle === regime.cpuThrottle));
  const allRecords = useMemo(() => BENCHMARK_HISTORY.records.filter((record) =>
    record.harness === harness && matchesRegime(record)
      && HISTORY_ENTRY_IDS.includes(record.entry)), [harness, regime]);
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
        label: text(`equal · ${scale / 1000}k`, `等权 · ${scale / 1000}k`),
        ops,
        adaptiveHistory: true,
        formulaLabel: text('equal-weight geometric mean', '等权几何平均'),
        equation: {
          head: text(`Equal-weight ${scale / 1000}k geometric mean`, `${scale / 1000}k 等权几何平均`),
          lines: [
            text('rᵢ = medianᵢ ÷ fastest medianᵢ', 'rᵢ = 中位数ᵢ ÷ 最快中位数ᵢ'),
            'score = exp(Σ ln(rᵢ) ÷ N)',
            text('N = operations complete for every entry at that dataset', 'N = 该 dataset 中对所有条目都完整的操作数'),
            text('A changed operation set is joined with a dashed bridge', '操作集合变化时使用虚线连接'),
          ],
        },
      };
    };
    return [
      ...(harness === 'web' ? [{
        key: 'weighted',
        label: text('weighted · available', '加权 · 可用单元'),
        ops: JS_FRAMEWORK_SCORE_OPS.map(({ key, workload, scale }) => ({ key, workload, scale })),
        weights: JS_FRAMEWORK_SCORE_OPS.map((op) => op.weight),
        adaptiveHistory: true,
        formulaLabel: text('coverage-adjusted upstream-weight geometric mean', '按覆盖率调整的上游权重几何平均'),
        equation: {
          head: text('Available-cell upstream weights', '可用单元的上游权重'),
          lines: [
            text('rᵢ = medianᵢ ÷ fastest medianᵢ', 'rᵢ = 中位数ᵢ ÷ 最快中位数ᵢ'),
            'score = exp(Σavailable wᵢ · ln(rᵢ) ÷ Σavailable wᵢ)',
            text('A missing cell is omitted for every entry; remaining weights are renormalized', '缺失单元会对所有条目共同省略；剩余权重重新归一化'),
            text('A changed cell set is dashed; 9/9 is exact upstream coverage', '单元集合变化时使用虚线；9/9 才是精确的上游覆盖'),
          ],
        },
      }] : []),
      equalMode(1000),
      equalMode(10000),
    ];
  }, [allRecords, harness, text]);
  const initialCase = param('historyCase');
  const [rankView, setRankView] = useState<RankView>(() =>
    param('historyView') === CELL_VIEW || (initialCase != null && initialCase !== 'interactive')
      ? CELL_VIEW : SCORE_VIEW);
  const [historyBasis, setHistoryBasis] = useState<HistoryBasis>(() =>
    param('historyBasis') === ORIGINAL_BASIS ? ORIGINAL_BASIS : REPLAY_BASIS);
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
  const replayAvailable = harness === 'web'
    && regime.jsRegime === 'jit' && regime.cpuThrottle === 1
    && WEB_HISTORY_REPLAY != null
    && (isAggregate || activeMetric === 'latency');
  const activeHistoryBasis: HistoryBasis = replayAvailable
    ? historyBasis
    : ORIGINAL_BASIS;

  useEffect(() => {
    if (activeWorkload !== workload) setWorkload(activeWorkload);
    if (activeMetric !== metric) setMetric(activeMetric);
    if (activeScale != null && activeScale !== scale) setScale(activeScale);
  }, [activeWorkload, workload, activeMetric, metric, activeScale, scale]);

  const points = useMemo(() => {
    const out: RankedPoint[] = [];
    for (const [index, checkpoint] of BENCHMARK_HISTORY.checkpoints.entries()) {
      const cohort = checkpoint.harnesses.find(matchesCohort);
      if (!cohort) continue;
      const originalRecords = historyRecordsForCheckpoint(checkpoint)
        .filter((record) => record.harness === harness && matchesRegime(record)) as HistoryRecord[];
      const replayRecords = WEB_HISTORY_REPLAY && harness === 'web'
        ? historyReplayRecordsForCheckpoint(WEB_HISTORY_REPLAY, checkpoint)
        : [];
      const checkpointRecords = activeHistoryBasis === REPLAY_BASIS && replayRecords.length > 0
        ? replayRecords
        : originalRecords;
      const machineId = activeHistoryBasis === REPLAY_BASIS && replayRecords.length > 0
        ? WEB_HISTORY_REPLAY!.machineId
        : cohort.machineId;
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
        machineId,
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
          machineId,
          ...(isAggregate ? { aggregateCellKeys: aggregateCells.map((cell) => cell.key) } : {}),
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
    for (const entry of HISTORY_ENTRY_IDS) {
      let previous: RankedPoint | null = null;
      for (const point of out.filter((candidate) => candidate.entry === entry)) {
        point.previousRank = previous?.rank ?? null;
        point.rankDelta = point.rank != null && previous?.rank != null
          ? previous.rank - point.rank
          : null;
        previous = point.status === 'ranked' ? point : previous;
      }
    }
    return out;
  }, [harness, regime, activeWorkload, activeScale, activeMetric, isAggregate, activeScoreMode,
    activeHistoryBasis]);

  const checkpointAudits = useMemo(() => {
    const audits: DatasetChangeAudit[] = [];
    let previous: {
      checkpoint: HistoryCheckpoint;
      entries: string[];
      commits: Map<string, string | null>;
      formulaKeys: string[];
      machineId: string;
    } | null = null;
    for (const checkpoint of BENCHMARK_HISTORY.checkpoints) {
      const cohort = checkpoint.harnesses.find(matchesCohort);
      if (!cohort) continue;
      const checkpointPoints = points.filter((point) => point.checkpoint.id === checkpoint.id);
      const sample = checkpointPoints[0];
      const formulaKeys = isAggregate
        ? sample?.aggregateCellKeys ?? []
        : [`${activeWorkload}@${activeScale}:${activeMetric}`];
      const commits = new Map(checkpoint.identityPointers.map((pointer) =>
        [pointer.entryId, pointer.commit]));
      const machineId = sample?.machineId ?? cohort.machineId;
      if (!previous) {
        audits.push({
          checkpoint,
          baseline: true,
          sourceChanges: [],
          cohortAdded: [],
          cohortRemoved: [],
          formulaAdded: [],
          formulaRemoved: [],
          machineChanged: false,
          previousMachineId: null,
          machineId,
          hasChanges: false,
        });
      } else {
        const sourceChanges: EntrySourceChange[] = [];
        const allEntries = new Set([...previous.commits.keys(), ...commits.keys()]);
        for (const entry of allEntries) {
          const from = previous.commits.get(entry) ?? null;
          const to = commits.get(entry) ?? null;
          if (from === to) continue;
          sourceChanges.push({
            entry,
            kind: from == null ? 'added' : to == null ? 'removed' : 'changed',
            from,
            to,
          });
        }
        const cohortAdded = cohort.entryIds.filter((entry) => !previous!.entries.includes(entry));
        const cohortRemoved = previous.entries.filter((entry) => !cohort.entryIds.includes(entry));
        const formulaAdded = formulaKeys.filter((key) => !previous!.formulaKeys.includes(key));
        const formulaRemoved = previous.formulaKeys.filter((key) => !formulaKeys.includes(key));
        const machineChanged = previous.machineId !== machineId;
        audits.push({
          checkpoint,
          baseline: false,
          sourceChanges,
          cohortAdded,
          cohortRemoved,
          formulaAdded,
          formulaRemoved,
          machineChanged,
          previousMachineId: previous.machineId,
          machineId,
          hasChanges: sourceChanges.length > 0
            || cohortAdded.length > 0
            || cohortRemoved.length > 0
            || formulaAdded.length > 0
            || formulaRemoved.length > 0
            || machineChanged,
        });
      }
      previous = {
        checkpoint,
        entries: cohort.entryIds,
        commits,
        formulaKeys,
        machineId,
      };
    }
    return audits;
  }, [points, harness, isAggregate, activeWorkload, activeScale, activeMetric]);
  const auditByCheckpoint = useMemo(() => new Map(checkpointAudits.map((audit) =>
    [audit.checkpoint.id, audit])), [checkpointAudits]);

  const selectedCheckpoint = BENCHMARK_HISTORY.checkpoints[snapshotIndex];
  const selectedPoints = points.filter((point) => point.checkpoint.id === selectedCheckpoint.id);
  const selectedAudit = auditByCheckpoint.get(selectedCheckpoint.id) ?? null;
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
      const checkpointCopy = localizedCheckpoint(point.checkpoint, locale);
      const cohortSize = point.checkpoint.harnesses
        .find(matchesCohort)?.entryIds.length ?? '?';
      const status = point.status === 'ranked'
        ? text(`rank ${point.rank} of ${cohortSize}`, `第 ${point.rank} 名，共 ${cohortSize} 项`)
        : point.status === 'incomparable' ? text('not ranked — incomparable transport work', '未排名——transport 工作不可比')
          : point.status === 'observation' ? text('not ranked — isolated observation', '未排名——孤立观察值')
            : point.status === 'dnf' ? text('not ranked — DNF', '未排名——DNF') : text('not run in this exact cohort', '未在此精确 cohort 中运行');
      const audit = auditByCheckpoint.get(point.checkpoint.id);
      const ownSourceChange = audit?.sourceChanges.find((change) =>
        change.entry === point.entry);
      const delta = rankDeltaGlyph(point.rankDelta);
      const changeSummary = ownSourceChange
        ? text(
          `* source ${ownSourceChange.kind}${delta ? ` · rank ${delta}` : ''}`,
          `* 来源${ownSourceChange.kind === 'added' ? '加入' : ownSourceChange.kind === 'removed' ? '移除' : '变更'}${delta ? ` · 排名 ${delta}` : ''}`,
        )
        : delta
          ? audit?.machineChanged || audit?.formulaAdded.length || audit?.formulaRemoved.length
            || audit?.cohortAdded.length || audit?.cohortRemoved.length
            ? text(`rank ${delta} across a comparison-contract change`, `排名 ${delta}，跨越对比合约变化`)
            : activeHistoryBasis === ORIGINAL_BASIS
              ? text(`rank ${delta} with unchanged source · run-to-run variance`, `来源未变但排名 ${delta} · 跨运行波动`)
              : text(`rank ${delta} with shared replay controls`, `统一 replay 对照下排名 ${delta}`)
          : activeHistoryBasis === REPLAY_BASIS
            ? text('shared 11-rep replay control', '共享 11 次重复 replay 对照')
            : null;
      return [
        point.label,
        `${status}  ·  ${formatPointValue(point, locale)}`,
        datasetAxisLabel(point.checkpoint.id, locale),
        changeSummary,
        point.aggregateCellCount != null
          ? text(
            `${point.aggregateCellCount}/${activeScoreMode?.ops.length ?? point.aggregateCellCount} available cells  ·  ${activeScoreMode?.formulaLabel ?? 'geometric mean'}`,
            `${point.aggregateCellCount}/${activeScoreMode?.ops.length ?? point.aggregateCellCount} 个可用单元  ·  ${activeScoreMode?.formulaLabel ?? '几何平均'}`,
          )
          : record ? `${record.boundary}  ·  n=${record.n}${record.dnfCount ? `  ·  ${record.dnfCount} DNF` : ''}` : checkpointCopy.description,
      ].filter(Boolean).join('\n');
    };
    const width = Math.max(760, plotWidth || node.clientWidth || 760);
    const plot = Plot.plot({
      width,
      height: 390,
      marginLeft: 52,
      marginRight: 18,
      marginBottom: 64,
      style: { background: 'transparent', color: fg, fontSize: '11px' },
      x: {
        label: text('dataset sequence →', 'dataset 序列 →'),
        type: 'point',
        domain: DATASET_IDS,
        tickFormat: (id: string) => `${datasetAxisLabel(id, locale)}${auditByCheckpoint.get(id)?.hasChanges ? ' *' : ''}`,
        grid: true,
        padding: 0.45,
      },
      y: {
        label: text('rank (lower is better)', '排名（越低越好）'),
        domain: [1, statusRank],
        reverse: true,
        ticks: statusRank,
        tickFormat: (value: number) => value === statusRank ? text('gap', '缺口') : `#${value}`,
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
        Plot.text(rankedPoints.filter((point) =>
          point.checkpoint.id !== selectedCheckpoint.id
          && (point.rankDelta || auditByCheckpoint.get(point.checkpoint.id)?.sourceChanges
            .some((change) => change.entry === point.entry))), {
          x: 'dataset',
          y: 'rank',
          text: (point: RankedPoint) => {
            const sourceChanged = auditByCheckpoint.get(point.checkpoint.id)?.sourceChanges
              .some((change) => change.entry === point.entry);
            return `${sourceChanged ? '* ' : ''}${rankDeltaGlyph(point.rankDelta)}`.trim();
          },
          dx: 7,
          dy: -9,
          textAnchor: 'start',
          fill: 'entry',
          stroke: background,
          strokeWidth: 3,
          paintOrder: 'stroke',
          fontWeight: 760,
          fontSize: 9,
          className: 'history-series history-series-delta',
        }),
        Plot.text(selectedPoints.filter((point) => point.status === 'ranked'), {
          x: 'dataset',
          y: 'rank',
          text: (point: RankedPoint) => {
            const sourceChanged = auditByCheckpoint.get(point.checkpoint.id)?.sourceChanges
              .some((change) => change.entry === point.entry);
            const delta = rankDeltaGlyph(point.rankDelta);
            return `${point.label}${sourceChanged ? ' *' : ''}  ${formatPointValue(point, locale)}${delta ? `  ${delta}` : ''}`;
          },
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
    selectedCheckpoint, snapshotIndex, activeScale, harness, locale, plotWidth, text, theme,
    auditByCheckpoint, activeHistoryBasis]);

  const changeRankView = (value: string) => {
    const next = value === CELL_VIEW ? CELL_VIEW : SCORE_VIEW;
    setRankView(next);
    syncParam('historyView', next === SCORE_VIEW ? null : next);
  };
  const changeHistoryBasis = (value: string) => {
    const next = value === ORIGINAL_BASIS ? ORIGINAL_BASIS : REPLAY_BASIS;
    setHistoryBasis(next);
    syncParam('historyBasis', next === REPLAY_BASIS ? null : next);
  };
  const changeScoreMode = (value: string) => {
    setScoreModeKey(value);
    syncParam('historyScore', value === 'weighted' ? null : value);
  };
  const changeWorkload = (value: string) => { setWorkload(value); syncParam('historyCase', value === 'create' ? null : value); };
  const changeMetric = (value: string) => { setMetric(value); syncParam('historyMetric', value === 'latency' ? null : value); };
  const changeScale = (value: number) => { setScale(value); syncParam('historyScale', value === 1000 ? null : String(value)); };

  const selectedChangeItems: Array<{ kind: string; copy: string }> = [];
  if (selectedAudit?.baseline) {
    selectedChangeItems.push({
      kind: text('baseline', '基线'),
      copy: text('First retained dataset; no preceding checkpoint.', '首个保留 dataset；没有前一节点。'),
    });
  } else if (selectedAudit) {
    if (selectedAudit.sourceChanges.length > 0) {
      selectedChangeItems.push({
        kind: text('source', '来源'),
        copy: selectedAudit.sourceChanges.map((change) => {
          const label = shortLabel(change.entry);
          if (change.kind === 'added') return `${label} + @${change.to?.slice(0, 8)}`;
          if (change.kind === 'removed') return `${label} − @${change.from?.slice(0, 8)}`;
          return `${label} ${change.from?.slice(0, 8)} → ${change.to?.slice(0, 8)}`;
        }).join(' · '),
      });
    }
    if (selectedAudit.cohortAdded.length > 0 || selectedAudit.cohortRemoved.length > 0) {
      selectedChangeItems.push({
        kind: 'cohort',
        copy: [
          ...selectedAudit.cohortAdded.map((entry) => `+ ${shortLabel(entry)}`),
          ...selectedAudit.cohortRemoved.map((entry) => `− ${shortLabel(entry)}`),
        ].join(' · '),
      });
    }
    if (selectedAudit.formulaAdded.length > 0 || selectedAudit.formulaRemoved.length > 0) {
      selectedChangeItems.push({
        kind: text('formula', '公式'),
        copy: [
          ...selectedAudit.formulaAdded.map((key) => `+ ${key}`),
          ...selectedAudit.formulaRemoved.map((key) => `− ${key}`),
        ].join(' · '),
      });
    }
    if (selectedAudit.machineChanged) {
      selectedChangeItems.push({
        kind: text('machine', '机器'),
        copy: `${selectedAudit.previousMachineId} → ${selectedAudit.machineId}`,
      });
    }
    if (selectedChangeItems.length === 0) {
      selectedChangeItems.push({
        kind: text('stable', '稳定'),
        copy: activeHistoryBasis === REPLAY_BASIS
          ? text(
            'Same source, cohort, formula and shared replay observations; unchanged peers cannot drift here.',
            '来源、cohort、公式及共享 replay 观测均未变化；未变 peer 不会在这里漂移。',
          )
          : text(
            'Same source, cohort, formula and machine; any rank movement is run-to-run measurement variance.',
            '来源、cohort、公式和机器均未变化；任何排名移动都属于跨运行测量波动。',
          ),
      });
    }
  }

  return (
    <section className="history-ranking" aria-labelledby="history-ranking-title">
      <div className="history-heading">
        <div>
          <div className="history-kicker">{text('Exact-source history', '精确来源历史')}</div>
          <h2 id="history-ranking-title">{text('Rank by dataset', '按 dataset 排名')}</h2>
          <ResponsiveCopy className="history-copy">
            {text(
              'Each node is one retained dataset. Unified replay is the default: exact historical bundles share one 11-repetition machine run and the complete current formula, while Original runs remains available as dated evidence. Asterisks mark source or comparison-contract changes; arrows show rank movement.',
              '每个节点代表一个保留的 dataset。默认使用统一 replay：精确历史 bundle 共享同一次机器上的 11 次重复运行和完整当前公式；仍可切回当时原始观测。星号标记来源或对比合约变化，箭头表示排名移动。',
            )}
          </ResponsiveCopy>
        </div>
      </div>
      <div className="history-browser" aria-label={text('Browse ranking configuration', '浏览排名配置')}>
        <div className="history-browser-heading">
          <span>{text('Browse configuration', '浏览配置')}</span>
          <output>{isAggregate && activeScoreMode
            ? text(
              `${activeScoreMode.label} · ${selectedAggregateCellCount ?? 0}/${activeScoreMode.ops.length} cells · relative geomean`,
              `${activeScoreMode.label} · ${selectedAggregateCellCount ?? 0}/${activeScoreMode.ops.length} 单元 · 相对几何平均`,
            )
            : `${localizedWorkload(activeWorkload, locale)} · ${activeScale?.toLocaleString()} ${text('rows', '行')} · ${metricLabel(activeMetric, locale)}`}</output>
        </div>
        <ChoiceRail
          label={text('Lynx for', 'Lynx 环境')}
          value={harness}
          options={[{ value: 'web', label: 'Web' }, { value: 'native', label: 'Native' }]}
          onChange={onHarnessChange}
        />
        <ChoiceRail
          label={text('Evidence', '证据')}
          value={activeHistoryBasis}
          options={[
            {
              value: REPLAY_BASIS,
              label: text('Unified replay', '统一 replay'),
              disabled: !replayAvailable,
              equation: {
                head: text('Calibrated historical comparison', '校准后的历史对比'),
                lines: [
                  text('Exact historical bundle artifacts, verified by commit and SHA-256', '精确历史 bundle artifact，以 commit 和 SHA-256 验证'),
                  text('One machine run · 11 repetitions · 12/12 standard latency cells', '同一次机器运行 · 11 次重复 · 12/12 标准 latency 单元'),
                  text('Stable React/Vue observations are reused at every checkpoint', '稳定的 React/Vue 观测在每个 checkpoint 复用'),
                ],
              },
            },
            {
              value: ORIGINAL_BASIS,
              label: text('Original runs', '原始运行'),
              equation: {
                head: text('Dated source evidence', '当时的来源证据'),
                lines: [
                  text("Uses each checkpoint's original run, machine and available cell matrix", '使用每个 checkpoint 当时的运行、机器和可用 cell 矩阵'),
                  text('Preserves historical noise and formula gaps for audit', '保留历史测量噪声与公式缺口以供审计'),
                ],
              },
            },
          ]}
          onChange={changeHistoryBasis}
        />
        <ChoiceRail
          label={text('Rank', '排名')}
          value={rankView}
          options={[
            { value: SCORE_VIEW, label: text('Composite score', '复合得分') },
            { value: CELL_VIEW, label: text('Single measurement', '单项测量') },
          ]}
          onChange={changeRankView}
        />
        {isAggregate && activeScoreMode ? (
          <ChoiceRail
            label={text('Formula', '公式')}
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
                  label={text('Case', '测试项')}
              value={activeWorkload}
              options={workloads.map((value) => ({ value, label: localizedWorkload(value, locale) }))}
              onChange={changeWorkload}
            />
            <ChoiceRail
              label={text('Scale', '规模')}
              value={String(activeScale)}
              options={scales.map((value) => ({ value: String(value), label: `${value.toLocaleString()} ${text('rows', '行')}` }))}
              onChange={(value) => changeScale(Number(value))}
            />
            <ChoiceRail
              label={text('Metric', '指标')}
              value={activeMetric}
              options={metrics.map((value) => ({ value, label: metricLabel(value, locale) }))}
              onChange={changeMetric}
            />
          </>
        )}
      </div>
      <div className={`history-change-ledger${selectedAudit?.hasChanges ? ' has-change' : ''}`}>
        <span className="history-change-asterisk" aria-hidden="true">
          {selectedAudit?.hasChanges ? '*' : '·'}
        </span>
        <div className="history-change-context">
          <span>{text('Change ledger', '变化台账')}</span>
          <strong>{localizedCheckpoint(selectedCheckpoint, locale).label}</strong>
        </div>
        <div className="history-change-items">
          {selectedChangeItems.map((item) => (
            <span className="history-change-item" key={`${item.kind}:${item.copy}`}>
              <b>{item.kind}</b>{item.copy}
            </span>
          ))}
        </div>
        <span className="history-basis-receipt">
          {activeHistoryBasis === REPLAY_BASIS && WEB_HISTORY_REPLAY
            ? text(
              `${WEB_HISTORY_REPLAY.minimumReps} reps · ${WEB_HISTORY_REPLAY.cellKeys.length}/12 latency cells`,
              `${WEB_HISTORY_REPLAY.minimumReps} 次重复 · ${WEB_HISTORY_REPLAY.cellKeys.length}/12 latency 单元`,
            )
            : text(
              `${selectedAggregateCellCount ?? 1}/${activeScoreMode?.ops.length ?? 1} selected formula cells · original`,
              `${selectedAggregateCellCount ?? 1}/${activeScoreMode?.ops.length ?? 1} 个所选公式单元 · 原始`,
            )}
        </span>
      </div>
      <div className="history-legend" aria-label={text('Framework colors', '框架颜色')}>
        <div className="history-entry-legend">
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
              aria-label={text(`Highlight ${shortLabel(entry.id)}`, `高亮 ${shortLabel(entry.id)}`)}
            >
              <i style={{ background: entryColor(entry.id, theme) }} />{shortLabel(entry.id)}
            </button>
          ))}
        </div>
        {compact ? (
          <details className="history-status">
            <summary>
              <span>{text('Mark key', '标记说明')}</span>
              <span className="history-status-chevron" aria-hidden="true">›</span>
            </summary>
            <div>{text(
              '* source/contract change · ↑↓ rank delta · – – cohort/formula bridge · ○ observation · ● incomparable · red DNF · faint missing',
              '* 来源/合约变化 · ↑↓ 排名变化 · – – cohort/公式桥接 · ○ 观察值 · ● 不可比 · 红色 DNF · 淡色缺失',
            )}</div>
          </details>
        ) : (
          <span className="history-status">{text(
            '* source/contract change · ↑↓ rank delta · – – cohort/formula bridge · ○ observation · ● incomparable · red DNF · faint missing',
            '* 来源/合约变化 · ↑↓ 排名变化 · – – cohort/公式桥接 · ○ 观察值 · ● 不可比 · 红色 DNF · 淡色缺失',
          )}</span>
        )}
      </div>
      <div className="history-plot" ref={ref} />
      <details className="history-evidence">
        <summary>{text(
          `Source evidence and gaps (${BENCHMARK_HISTORY.sources.length} audited runs)`,
          `来源证据与缺口（已审计 ${BENCHMARK_HISTORY.sources.length} 次运行）`,
        )}</summary>
        <div className="history-evidence-scroll">
          <table>
            <thead><tr><th>dataset</th><th>{text('framework', '框架')}</th><th>{text('rank', '排名')}</th><th>Δ</th><th>{text('value', '值')}</th><th>{text('change', '变化')}</th><th>{text('source / provenance', '来源 / 溯源')}</th></tr></thead>
            <tbody>
              {points.map((point) => {
                const audit = auditByCheckpoint.get(point.checkpoint.id);
                const sourceChanged = audit?.sourceChanges.some((change) =>
                  change.entry === point.entry);
                const contractChanged = audit?.machineChanged
                  || audit?.cohortAdded.length || audit?.cohortRemoved.length
                  || audit?.formulaAdded.length || audit?.formulaRemoved.length;
                return <tr key={`${point.checkpoint.id}:${point.entry}`}>
                  <td><button type="button" onClick={() => onSnapshotChange(BENCHMARK_HISTORY.checkpoints.indexOf(point.checkpoint))}>{localizedCheckpoint(point.checkpoint, locale).label}</button></td>
                  <td>{point.label}</td><td>{point.rank == null
                    ? ({ missing: text('missing', '缺失'), observation: text('observation', '观察值'), dnf: 'DNF', incomparable: text('incomparable', '不可比'), ranked: text('ranked', '已排名') } as const)[point.status]
                    : `#${point.rank}`}</td>
                  <td>{rankDeltaGlyph(point.rankDelta) || '—'}{sourceChanged ? ' *' : ''}</td>
                  <td>{formatPointValue(point, locale)}{point.aggregateCellCount != null
                    ? ` · ${point.aggregateCellCount}/${activeScoreMode?.ops.length ?? point.aggregateCellCount} ${text('cells', '单元')}`
                    : ''}</td>
                  <td>{sourceChanged
                    ? text('source changed', '来源变化')
                    : contractChanged
                      ? text('comparison contract changed', '对比合约变化')
                      : point.rankDelta
                        ? activeHistoryBasis === ORIGINAL_BASIS
                          ? text('run variance', '运行波动')
                          : text('replay rank delta', 'replay 排名变化')
                        : text('stable control', '稳定对照')}</td>
                  <td><code>{point.record?.runFile
                    ?? point.aggregateRecords?.[0]?.runFile
                    ?? localizedCheckpoint(point.checkpoint, locale).description}</code>{point.record?.entryCommit
                    ? ` @ ${point.record.entryCommit.slice(0, 12)}`
                    : point.aggregateRecords?.[0]?.entryCommit
                      ? ` @ ${point.aggregateRecords[0].entryCommit.slice(0, 12)}`
                      : ''}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
