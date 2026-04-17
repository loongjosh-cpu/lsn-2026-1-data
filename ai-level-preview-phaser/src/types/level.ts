export type FishTuple = [number, number, number, number, boolean];
export type ShellTuple = [number, number];

export interface LevelData {
  title: string;
  rows: number;
  cols: number;
  gridFish: FishTuple[];
  gridShells?: ShellTuple[];
}

