import { createContext, useContext, useMemo } from 'react';

import {
  BenchRecord,
  filterRecords,
  oneFrom,
  RecordFilter,
  TimelineSnapshot,
  workloadScalesFrom,
} from './data';

interface BenchmarkData {
  snapshot: TimelineSnapshot;
  records: BenchRecord[];
  select: (filter: RecordFilter) => BenchRecord[];
  one: (filter: RecordFilter) => BenchRecord | null;
  workloadScales: (filter: Omit<RecordFilter, 'scale'>) => number[];
  selectNativeObservations: (filter: RecordFilter) => BenchRecord[];
  selectWebLab: (filter: RecordFilter) => BenchRecord[];
  selectNativeLab: (filter: RecordFilter) => BenchRecord[];
}

const BenchmarkDataContext = createContext<BenchmarkData | null>(null);

export function BenchmarkDataProvider({
  snapshot,
  children,
}: {
  snapshot: TimelineSnapshot;
  children: React.ReactNode;
}) {
  const value = useMemo<BenchmarkData>(() => ({
    snapshot,
    records: snapshot.records,
    select: (filter) => filterRecords(snapshot.records, filter),
    one: (filter) => oneFrom(snapshot.records, filter),
    workloadScales: (filter) => workloadScalesFrom(snapshot.records, filter),
    selectNativeObservations: (filter) =>
      filterRecords(snapshot.nativeObservationRecords, filter),
    selectWebLab: (filter) => filterRecords(snapshot.webLabRecords, filter),
    selectNativeLab: (filter) => filterRecords(snapshot.nativeLabRecords, filter),
  }), [snapshot]);
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
