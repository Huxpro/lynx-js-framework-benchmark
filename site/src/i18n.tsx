import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { HistoryCheckpoint } from './data';

export type Locale = 'en' | 'zh-CN';

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  text: (english: string, chinese: string) => string;
  date: (value: string | Date, options?: Intl.DateTimeFormatOptions) => string;
}

const STORAGE_KEY = 'lynx-benchmark-locale';

function initialLocale(): Locale {
  const query = new URLSearchParams(location.search).get('lang');
  if (query === 'zh') return 'zh-CN';
  if (query === 'en') return 'en';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh-CN' || stored === 'en') return stored;
  return navigator.languages.some((language) => language.toLowerCase().startsWith('zh'))
    ? 'zh-CN'
    : 'en';
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const text = useCallback(
    (english: string, chinese: string) => locale === 'zh-CN' ? chinese : english,
    [locale],
  );
  const date = useCallback(
    (value: string | Date, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, options).format(new Date(value)),
    [locale],
  );
  const toggleLocale = useCallback(
    () => setLocale((current) => current === 'en' ? 'zh-CN' : 'en'),
    [],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === 'zh-CN'
      ? 'Lynx JS 框架基准测试'
      : 'Lynx JS Framework Benchmark';
    localStorage.setItem(STORAGE_KEY, locale);
    const params = new URLSearchParams(location.search);
    params.set('lang', locale === 'zh-CN' ? 'zh' : 'en');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, toggleLocale, text, date }),
    [date, locale, text, toggleLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

const CHECKPOINT_ZH: Record<string, { label: string; description: string }> = {
  '2026-08-08-peer-reference': {
    label: '8 月 8 日 · React/Vue 参照组',
    description: '最早保留的对比是同一次运行中的五项 React/Vue 参照组，共有 90 个非 storm 共享测试单元。同一原始运行也记录了早期 Octane，但这个节点只把它作为来源证据；这样下一个节点能明确展示 Octane 加入排名，而不是悄悄改变基线。',
  },
  '2026-08-10-slow-octane': {
    label: '8 月 10 日 · 较慢的 Octane 加入',
    description: '上游 Octane e81fd879 加入五项参照组。在 11 个共享交互延迟单元上，它的几何平均值是 React 的 3.91×；本次运行中的 Hux 和 DOM 实验仅作为来源证据，不进入这个节点。',
  },
  '2026-08-11-octane-step-change': {
    label: '8 月 11 日 · Octane 阶跃变化',
    description: '上游 Octane 更新到 9b147781，其他五项和 99 单元非 storm 矩阵保持不变。它相对 React 的 11 单元延迟几何平均值从 3.91× 降至 1.32×（降低 66%），因此这是一次实质性的框架变化，而不只是又一次运行。',
  },
  '2026-08-15-octane-converges': {
    label: '8 月 15 日 · Octane 趋于收敛',
    description: '上游 Octane 更新到 63eb7888，仍使用相同的六项 cohort 和 99 个共享非 storm 单元。它相对 React 的 11 单元延迟几何平均值达到 1.14×，比 8 月 11 日再低 14%；中间的 6079a680 运行仅保留为来源证据，因为额外变化只有约 5.5%，且 cohort 与 workload 合约都没有改变。',
  },
  '2026-08-22-new-lynx': {
    label: '8 月 22 日 · Octane (Hux) 加入',
    description: 'cohort 从六项扩展为七项：Huxpro/new-lynx fb8426e9 与上游 Octane 0fc84da0 同时参与，共有 101 个共享非 storm 测试单元。在相同的 11 个交互单元上，Hux 是上游的 0.84×、React 的 0.92×；这是来源 cohort 的变化，而不是仅按日期保留的重跑。',
  },
  'current-main': {
    label: '当前 · 已合并上游',
    description: '上游 Octane 从 0fc84da0 更新到 5227d7ba，并已包含合并后的 PR #791；七项 cohort 仍将 Octane (Hux) fb8426e9 保留为独立来源身份。在 11 个共享交互单元上，上游相对 React 从 1.09× 改善到 0.88×。公开对比同时采用与标准对齐的黑盒 workload，storm 实验仅保留为归档证据。',
  },
};

export function localizedCheckpoint(
  checkpoint: HistoryCheckpoint,
  locale: Locale,
): Pick<HistoryCheckpoint, 'label' | 'description'> {
  return locale === 'zh-CN' && CHECKPOINT_ZH[checkpoint.id]
    ? CHECKPOINT_ZH[checkpoint.id]
    : checkpoint;
}

const WORKLOAD_ZH: Record<string, string> = {
  create: '创建',
  replace: '替换',
  append1k: '追加 1k',
  update10th: '更新每第 10 行',
  select: '选择',
  swap: '交换',
  remove: '移除',
  clear: '清空',
  updateStorm: '连续更新',
  selectStorm: '连续选择',
  memory: '内存',
  memoryAfterClear: '清空后内存',
  startup: '启动',
};

export function localizedWorkload(workload: string, locale: Locale): string {
  return locale === 'zh-CN' ? WORKLOAD_ZH[workload] ?? workload : workload;
}
