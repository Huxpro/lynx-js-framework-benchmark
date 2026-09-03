import {
  NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY,
  nativeOutcomeState,
} from './derive.mjs';

function reasonLabel(category, text) {
  if (category === NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY) {
    return text('capacity · Android ART global-reference table', '容量 · Android ART 全局引用表');
  }
  if (category === 'timeout') return text('timeout', '超时');
  if (category === 'process-failure') return text('process failure', '进程失败');
  return category;
}

function outcomeReasonSummary(record, text) {
  return Object.entries(record.outcomeCounts?.byReason ?? {})
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${count} ${reasonLabel(category, text)}`)
    .join(' · ');
}

function formatMedian(record, formatMs) {
  if (record.unit === 'ms') return formatMs(record.median);
  return `${record.median.toLocaleString()} ${record.unit}`;
}

export function nativeObservationStatus(record, { text, formatMs }) {
  if (!record) return text('not run', '未运行');
  const outcome = nativeOutcomeState(record);
  if (outcome === 'not-measured') {
    const reason = record.notMeasuredReason?.category ?? 'observer unavailable';
    return text(`not measured · ${reason}`, `未测量 · ${reason}`);
  }
  if (record.thresholdProbe === true
    && record.reportability?.status === 'not-reportable') {
    const completed = record.outcomeCounts?.outcomeOnlyCompleted ?? 0;
    const attempted = record.outcomeCounts?.attempted ?? record.attemptedCount ?? 0;
    const reasons = outcomeReasonSummary(record, text);
    return text(
      `outcome only · ${completed}/${attempted} completed · timing disabled`
        + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`
        + `${reasons ? ` · ${reasons}` : ''}`,
      `仅结果 · ${completed}/${attempted} 已完成 · 计时已禁用`
        + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`
        + `${reasons ? ` · ${reasons}` : ''}`,
    );
  }
  if (outcome === 'not-reportable' && record.reportability) {
    const reasons = outcomeReasonSummary(record, text);
    return text(
      `not reportable · ${record.acceptedCount ?? 0}/${record.reportability.minAcceptedSamples} accepted`
        + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`
        + `${reasons ? ` · ${reasons}` : ''}`,
      `不可报告 · 接受 ${record.acceptedCount ?? 0}/${record.reportability.minAcceptedSamples}`
        + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`
        + `${reasons ? ` · ${reasons}` : ''}`,
    );
  }
  if (record.median != null) {
    return `${formatMedian(record, formatMs)} · n=${record.n}`
      + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`;
  }
  const failure = record.failures?.[0];
  const reasons = outcomeReasonSummary(record, text);
  const category = reasons || reasonLabel(failure?.category ?? 'DNF', text);
  const timeout = failure?.timeoutMs
    ? text(
      ` · ${(failure.timeoutMs / 1000).toFixed(0)}s ceiling`,
      ` · 上限 ${(failure.timeoutMs / 1000).toFixed(0)} 秒`,
    )
    : '';
  return `${record.dnfCount} DNF · ${category}${timeout}`;
}
