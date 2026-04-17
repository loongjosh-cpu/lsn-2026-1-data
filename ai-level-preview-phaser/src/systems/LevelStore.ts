import Phaser from "phaser";
import levels from "../data/levels.json";
import type { FishTuple, LevelData, ShellTuple } from "../types/level";

type RawLevelData = Omit<LevelData, "gridFish" | "gridShells"> & {
  gridFish: Array<Array<number | boolean>>;
  gridShells?: Array<Array<number>>;
};

function toFishTuple(raw: Array<number | boolean>): FishTuple {
  return [
    Number(raw[0] ?? 0),
    Number(raw[1] ?? 0),
    Number(raw[2] ?? 0),
    Number(raw[3] ?? 0),
    Boolean(raw[4] ?? false)
  ];
}

function toShellTuple(raw: Array<number>): ShellTuple {
  return [Number(raw[0] ?? 0), Number(raw[1] ?? 0)];
}

function normalizeLevel(raw: RawLevelData): LevelData {
  return {
    title: raw.title,
    rows: Number(raw.rows),
    cols: Number(raw.cols),
    gridFish: (raw.gridFish ?? []).map(toFishTuple),
    gridShells: (raw.gridShells ?? []).map(toShellTuple)
  };
}

export class LevelStore {
  private readonly levels: LevelData[];
  private currentIndex = 0;

  constructor() {
    this.levels = (levels as RawLevelData[]).map(normalizeLevel);
  }

  getCurrent(): LevelData {
    return this.levels[this.currentIndex];
  }

  getAll(): LevelData[] {
    return this.levels;
  }

  getIndex(): number {
    return this.currentIndex;
  }

  getCount(): number {
    return this.levels.length;
  }

  setIndex(index: number): LevelData {
    this.currentIndex = Phaser.Math.Wrap(index, 0, this.levels.length);
    return this.getCurrent();
  }

  next(): LevelData {
    return this.setIndex(this.currentIndex + 1);
  }

  prev(): LevelData {
    return this.setIndex(this.currentIndex - 1);
  }

  replaceCurrent(level: LevelData): LevelData {
    this.levels[this.currentIndex] = {
      ...level,
      gridShells: level.gridShells ?? []
    };
    return this.getCurrent();
  }
}
