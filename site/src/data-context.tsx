import { createContext, useContext, useMemo } from 'react';

import {
  BenchRecord,
  filterRecords,
  oneFrom,
  RecordFilter,
  TimelineSnapshot,
  WebRegime,
  recordMatchesWebRegime,
  workloadScalesFrom,
} from './data';

interface BenchmarkData {
  snapshot: TimelineSnapshot;
  records: BenchRecord[];
  select: (filter: RecordFilter) => BenchRecord[];
  one: (filter: RecordFilter) => BenchRecord | null;
  workloadScales: (filter: Omit<RecordFilter, 'scale'>) => number[];
  selectNativeObservations: (filter: RecordFilter) => BenchRecord[];
  regime: WebRegime;
}

const BenchmarkDataContext = createContext<BenchmarkData | null>(null);

export function BenchmarkDataProvider({
  snapshot,
  regime,
  children,
}: {
  snapshot: TimelineSnapshot;
  regime: WebRegime;
  children: React.ReactNode;
}) {
  const value = useMemo<BenchmarkData>(() => {
    const records = snapshot.records.filter((record) =>
      record.suite === 'bundle' || recordMatchesWebRegime(record, regime));
    return ({
    snapshot,
    regime,
    records,
    select: (filter) => filterRecords(records, filter),
    one: (filter) => oneFrom(records, filter),
    workloadScales: (filter) => workloadScalesFrom(records, filter),
    selectNativeObservations: (filter) =>
      filterRecords(snapshot.nativeObservationRecords, filter),
  });
  }, [regime, snapshot]);
  return (
    <BenchmarkDataContext.Provider value={value}>
      {children}
    </BenchmarkDataContext.Provider>
  );
}

export function useBenchmarkData(): BenchmarkData {
  const value = useContext(BenchmarkDataContext);
  if (!value) throw new Error('useBenchmarkData must be used inside BenchmarkDataProvider');
  return value;
}
