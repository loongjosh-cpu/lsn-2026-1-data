import type { FishTuple } from "../types/level";

export interface GridLayout {
  cellSize: number;
  startX: number;
  startY: number;
}

export interface Point {
  x: number;
  y: number;
}

export function getNodePosition(row: number, col: number, layout: GridLayout): Point {
  return {
    x: layout.startX + col * layout.cellSize * 0.866,
    y: layout.startY + row * layout.cellSize + (col % 2 === 1 ? layout.cellSize * 0.5 : 0)
  };
}

export function buildLayout(
  width: number,
  height: number,
  rows: number,
  cols: number,
  topReserve: number,
  bottomReserve: number,
  sidePadding: number
): GridLayout {
  const usableWidth = Math.max(220, width - sidePadding * 2);
  const usableHeight = Math.max(220, height - topReserve - bottomReserve);
  const boardWidthUnits = Math.max(1, (cols - 1) * 0.866 + 1.15);
  const boardHeightUnits = Math.max(1, rows + 0.35);
  const cellSize = Math.min(usableWidth / boardWidthUnits, usableHeight / boardHeightUnits);
  const boardWidth = (cols - 1) * cellSize * 0.866 + cellSize;
  const boardHeight = (rows - 1) * cellSize + cellSize;
  const boardLeft = (width - boardWidth) / 2;
  const boardTop = topReserve + (usableHeight - boardHeight) / 2;
  return {
    cellSize,
    startX: boardLeft + cellSize * 0.5,
    startY: boardTop + cellSize * 0.5
  };
}

export function fishRenderLength(fish: FishTuple, layout: GridLayout): number {
  const dx = fish[2] - fish[0];
  const dy = fish[3] - fish[1];
  return Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy))) * layout.cellSize;
}

