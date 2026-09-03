import type { BenchRecord } from './data';

export function nativeObservationStatus(
  record: BenchRecord | undefined,
  options: {
    text: (english: string, chinese: string) => string;
    formatMs: (value: number) => string;
  },
): string;
