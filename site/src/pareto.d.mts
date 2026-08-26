export interface ParetoDatum {
  entry?: string;
  bytes: number;
  fcp: number;
}

export function paretoFrontier<T extends ParetoDatum>(points: T[]): T[];
export function paretoLine<T extends ParetoDatum>(points: T[]): T[];
