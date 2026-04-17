import Phaser from "phaser";
import { MOBILE_BREAKPOINT, SIDE_PADDING } from "../core/config";
import { buildLayout, getNodePosition } from "../game/geometry";
import { LevelStore } from "../systems/LevelStore";
import type { LevelData } from "../types/level";

interface RuntimeFish {
  tailRow: number;
  tailCol: number;
  headRow: number;
  headCol: number;
  state: "idle" | "swimming" | "returning";
  tailX: number;
  tailY: number;
  headX: number;
  headY: number;
  dirX: number;
  dirY: number;
  collisionDist: number;
  traveled: number;
  fixedLengthPx: number;
}

interface RuntimeGhost {
  tailX: number;
  tailY: number;
  headX: number;
  headY: number;
  dirX: number;
  dirY: number;
}

interface RuntimeShell {
  row: number;
  col: number;
}

interface DragState {
  fishIndex: number;
  startX: number;
  startY: number;
  moved: boolean;
  startHeadRow: number;
  startHeadCol: number;
  lastAngle: number;
  hoverHeadRow: number | null;
  hoverHeadCol: number | null;
}

interface NodeRef {
  row: number;
  col: number;
  x: number;
  y: number;
}

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export class GameScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private readonly store = new LevelStore();
  private unlockedCount = 1;
  private completed = new Set<number>();
  private levelsPanel: HTMLElement | null = null;
  private editorPanel: HTMLElement | null = null;
  private levelsGrid: HTMLElement | null = null;
  private editorRows: HTMLElement | null = null;
  private editorCols: HTMLElement | null = null;
  private editorFishes: HTMLElement | null = null;
  private editorJson: HTMLTextAreaElement | null = null;
  private editorStatus: HTMLElement | null = null;
  private winScreen: HTMLElement | null = null;
  private gameControls: HTMLElement | null = null;
  private editorToggle: HTMLElement | null = null;
  private headerContainer: HTMLElement | null = null;
  private mainCpDisplay: HTMLElement | null = null;

  private layout: ReturnType<typeof buildLayout> | null = null;
  private currentLevel: LevelData | null = null;
  private fishes: RuntimeFish[] = [];
  private flyingGhosts: RuntimeGhost[] = [];
  private shells: RuntimeShell[] = [];
  private drag: DragState | null = null;
  private selectedFishIndex: number | null = null;
  private levelClearHandled = false;

  constructor() {
    super("game");
  }

  create(): void {
    this.graphics = this.add.graphics();
    this.scale.on("resize", () => this.renderLevel());
    this.restoreProgress();
    this.bindHud();
    this.cacheHudElements();
    this.bindPanels();
    this.bindInput();
    this.renderLevelList();
    this.renderLevel();
    this.showMenu();
  }

  update(_: number, delta: number): void {
    if (!this.layout) return;

    const dt = Math.min(0.05, delta / 1000);
    const swimSpeed = this.layout.cellSize * 30;
    const returnSpeed = this.layout.cellSize * 34;
    const ghostSpeed = this.layout.cellSize * 30;
    let changed = false;

    for (const fish of this.fishes) {
      if (fish.state === "swimming") {
        const step = swimSpeed * dt;
        fish.tailX += fish.dirX * step;
        fish.tailY += fish.dirY * step;
        fish.headX += fish.dirX * step;
        fish.headY += fish.dirY * step;
        fish.traveled += step;
        if (fish.collisionDist !== Number.POSITIVE_INFINITY && fish.traveled >= fish.collisionDist) {
          fish.state = "returning";
        }
        changed = true;
        continue;
      }
      if (fish.state === "returning") {
        const targetTail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
        const targetHead = getNodePosition(fish.headRow, fish.headCol, this.layout);
        const step = returnSpeed * dt;
        const tailDone = this.movePointToward(fish, "tailX", "tailY", targetTail.x, targetTail.y, step);
        const headDone = this.movePointToward(fish, "headX", "headY", targetHead.x, targetHead.y, step);
        if (tailDone && headDone) {
          this.syncFishPoseToNodes(fish);
          fish.state = "idle";
          fish.collisionDist = Number.POSITIVE_INFINITY;
          fish.traveled = 0;
        }
        changed = true;
      }
    }

    for (const ghost of this.flyingGhosts) {
      const step = ghostSpeed * dt;
      ghost.tailX += ghost.dirX * step;
      ghost.tailY += ghost.dirY * step;
      ghost.headX += ghost.dirX * step;
      ghost.headY += ghost.dirY * step;
      changed = true;
    }

    this.flyingGhosts = this.flyingGhosts.filter((ghost) => !this.isGhostOffscreen(ghost));

    if (!this.levelClearHandled && this.fishes.length === 0) {
      this.onClearLevel();
      return;
    }

    if (!changed) return;
    this.renderRuntime();
  }

  private bindHud(): void {
    const title = document.getElementById("level-title");
    const meta = document.getElementById("level-meta");

    this.events.on("level-change", (level: LevelData) => {
      if (title) title.textContent = `关卡${this.store.getIndex() + 1}`;
      if (meta) meta.textContent = `${level.rows} x ${level.cols}`;
      this.renderLevelList();
      this.syncEditor(level);
    });
  }

  private cacheHudElements(): void {
    this.levelsPanel = document.getElementById("levels-panel");
    this.editorPanel = document.getElementById("editor-panel");
    this.levelsGrid = document.getElementById("levels-grid");
    this.editorRows = document.getElementById("editor-rows");
    this.editorCols = document.getElementById("editor-cols");
    this.editorFishes = document.getElementById("editor-fishes");
    this.editorJson = document.getElementById("editor-json") as HTMLTextAreaElement | null;
    this.editorStatus = document.getElementById("editor-status");
    this.winScreen = document.getElementById("win-screen");
    this.gameControls = document.getElementById("game-controls");
    this.editorToggle = document.getElementById("toggle-editor");
    this.headerContainer = document.getElementById("header-container");
    this.mainCpDisplay = document.getElementById("main-cp-display");
  }

  private bindPanels(): void {
    const toggleEditor = document.getElementById("toggle-editor");
    const applyEditor = document.getElementById("apply-editor");
    const resetEditor = document.getElementById("reset-editor");
    const editorBack = document.getElementById("editor-back");
    const unlockAll = document.getElementById("unlock-all-btn");
    const winNext = document.getElementById("win-next");
    const winMenu = document.getElementById("win-menu");
    const resetLevel = document.getElementById("reset-level");
    const backToMenu = document.getElementById("back-to-menu");

    toggleEditor?.addEventListener("click", () => {
      this.showEditor();
    });

    applyEditor?.addEventListener("click", () => this.applyEditorJson());
    resetEditor?.addEventListener("click", () => {
      this.setEditorStatus("已重载当前关卡 JSON。");
      this.syncEditor(this.store.getCurrent());
    });
    editorBack?.addEventListener("click", () => {
      this.showMenu();
    });
    unlockAll?.addEventListener("click", () => {
      this.unlockedCount = this.store.getCount();
      this.persistProgress();
      this.renderLevelList();
      this.setEditorStatus("所有关卡已解锁。");
    });
    winNext?.addEventListener("click", () => {
      this.hideWinScreen();
      this.advanceToNextLevel();
    });
    winMenu?.addEventListener("click", () => {
      this.returnToMenuFromWin();
    });
    resetLevel?.addEventListener("click", () => {
      this.hideWinScreen();
      this.renderLevel();
      this.enterGameplay();
      this.setEditorStatus("当前关卡已重置。");
    });
    backToMenu?.addEventListener("click", () => {
      this.hideWinScreen();
      this.showMenu();
    });
  }

  private returnToMenuFromWin(): void {
    // Rebuild current level state first so we don't stay on an already-cleared board.
    this.renderLevel();
    this.hideWinScreen();
    this.renderLevelList();
    this.showMenu();
  }

  private bindInput(): void {
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.layout || !this.currentLevel) return;
      if (this.levelsPanel?.style.display === "flex" || this.editorPanel?.style.display === "flex") return;
      if (this.fishes.some((fish) => fish.state !== "idle")) return;
      const fishIndex = this.pickFish(pointer.worldX, pointer.worldY);
      if (fishIndex === null) {
        this.selectedFishIndex = null;
        this.renderRuntime();
        return;
      }

      this.selectedFishIndex = fishIndex;
      this.drag = {
        fishIndex,
        startX: pointer.worldX,
        startY: pointer.worldY,
        moved: false,
        startHeadRow: this.fishes[fishIndex].headRow,
        startHeadCol: this.fishes[fishIndex].headCol,
        lastAngle: Phaser.Math.Angle.Between(
          this.fishes[fishIndex].tailX,
          this.fishes[fishIndex].tailY,
          this.fishes[fishIndex].headX,
          this.fishes[fishIndex].headY
        ),
        hoverHeadRow: null,
        hoverHeadCol: null
      };
      this.renderRuntime();
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.layout || !this.drag) return;
      const fish = this.fishes[this.drag.fishIndex];
      if (!fish || fish.state !== "idle") return;

      const movedDist = Phaser.Math.Distance.Between(
        this.drag.startX,
        this.drag.startY,
        pointer.worldX,
        pointer.worldY
      );
      if (movedDist > this.layout.cellSize * 0.18) this.drag.moved = true;
      if (!this.drag.moved) return;

      const rotated = this.rotateFishByDrag(this.drag, pointer.worldX, pointer.worldY);
      if (rotated) this.renderRuntime();
    });

    const finalizeDrag = () => {
      if (!this.drag) return;
      const fishIndex = this.drag.fishIndex;
      const moved = this.drag.moved;
      const hoverRow = this.drag.hoverHeadRow;
      const hoverCol = this.drag.hoverHeadCol;
      const fish = this.fishes[fishIndex];
      this.drag = null;

      if (!fish || fish.state !== "idle") {
        this.selectedFishIndex = null;
        this.renderRuntime();
        return;
      }

      if (!moved) {
        this.tryLaunchFishOnTap(fishIndex);
        this.selectedFishIndex = null;
        this.renderRuntime();
        return;
      }

      if (
        hoverRow !== null &&
        hoverCol !== null &&
        (hoverRow !== fish.headRow || hoverCol !== fish.headCol)
      ) {
        fish.headRow = hoverRow;
        fish.headCol = hoverCol;
        this.syncFishPoseToNodes(fish);
        this.tryAutoLaunchAfterRotate(fishIndex);
        this.selectedFishIndex = null;
        this.renderRuntime();
        return;
      }

      this.syncFishPoseToNodes(fish);
      this.selectedFishIndex = null;
      this.renderRuntime();
    };

    this.input.on("pointerup", finalizeDrag);
    this.input.on("pointerupoutside", finalizeDrag);
  }

  private renderLevelList(): void {
    if (!this.levelsGrid) return;

    const currentIndex = this.store.getIndex();
    const levels = this.store.getAll();
    this.levelsGrid.innerHTML = "";

    levels.forEach((level, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `level-card${index === currentIndex ? " active" : ""}`;
      const isUnlocked = index < this.unlockedCount;
      const isCompleted = this.completed.has(index);
      card.disabled = !isUnlocked;
      card.style.opacity = isUnlocked ? "1" : "0.52";
      card.style.cursor = isUnlocked ? "pointer" : "not-allowed";
      card.innerHTML = `
        <strong>关卡${index + 1}</strong>
        <span>${level.rows} × ${level.cols} · 鱼 ${level.gridFish.length} · 贝壳 ${level.gridShells?.length ?? 0}</span>
        <span>${isUnlocked ? (isCompleted ? "已通关，可重玩" : "已解锁") : "未解锁"}</span>
      `;
      card.addEventListener("click", () => {
        if (!isUnlocked) return;
        this.store.setIndex(index);
        this.renderLevel();
        this.setEditorStatus(`已切换到关卡${index + 1}。`);
        this.enterGameplay();
      });
      this.levelsGrid?.appendChild(card);
    });
  }

  private syncEditor(level: LevelData): void {
    if (this.editorRows) this.editorRows.textContent = String(level.rows);
    if (this.editorCols) this.editorCols.textContent = String(level.cols);
    if (this.editorFishes) this.editorFishes.textContent = String(level.gridFish.length);
    if (this.editorJson) {
      this.editorJson.value = JSON.stringify(
        {
          ...level,
          gridShells: level.gridShells ?? []
        },
        null,
        2
      );
    }
  }

  private applyEditorJson(): void {
    if (!this.editorJson) return;

    try {
      const parsed = JSON.parse(this.editorJson.value) as LevelData;
      this.validateLevel(parsed);
      this.store.replaceCurrent({
        ...parsed,
        gridShells: parsed.gridShells ?? []
      });
      this.setEditorStatus("当前关卡已更新。");
      this.renderLevel();
      this.showEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      this.setEditorStatus(`应用失败：${message}`);
    }
  }

  private validateLevel(level: LevelData): void {
    if (!Number.isInteger(level.rows) || !Number.isInteger(level.cols) || level.rows <= 0 || level.cols <= 0) {
      throw new Error("rows / cols 必须是正整数");
    }
    if (!Array.isArray(level.gridFish)) {
      throw new Error("gridFish 必须是数组");
    }
    if (level.gridShells && !Array.isArray(level.gridShells)) {
      throw new Error("gridShells 必须是数组");
    }
    level.gridFish.forEach((fish, index) => {
      if (!Array.isArray(fish) || fish.length < 5) {
        throw new Error(`第 ${index + 1} 条鱼格式不正确`);
      }
    });
  }

  private setEditorStatus(message: string): void {
    if (this.editorStatus) this.editorStatus.textContent = message;
  }

  private showMenu(): void {
    this.hideWinScreen();
    this.renderLevelList();
    if (this.levelsPanel) this.levelsPanel.style.display = "flex";
    if (this.editorPanel) this.editorPanel.style.display = "none";
    if (this.gameControls) this.gameControls.style.display = "none";
    if (this.editorToggle) this.editorToggle.style.display = "inline-flex";
    if (this.headerContainer) this.headerContainer.style.display = "block";
    if (this.mainCpDisplay) this.mainCpDisplay.style.display = "flex";
  }

  private showEditor(): void {
    if (this.editorPanel) this.editorPanel.style.display = "flex";
    if (this.levelsPanel) this.levelsPanel.style.display = "none";
    if (this.gameControls) this.gameControls.style.display = "none";
    if (this.editorToggle) this.editorToggle.style.display = "none";
    if (this.headerContainer) this.headerContainer.style.display = "block";
    if (this.mainCpDisplay) this.mainCpDisplay.style.display = "flex";
    this.syncEditor(this.store.getCurrent());
  }

  private hidePanels(): void {
    if (this.levelsPanel) this.levelsPanel.style.display = "none";
    if (this.editorPanel) this.editorPanel.style.display = "none";
  }

  private enterGameplay(): void {
    this.hidePanels();
    if (this.gameControls) this.gameControls.style.display = "flex";
    if (this.editorToggle) this.editorToggle.style.display = "none";
    if (this.headerContainer) this.headerContainer.style.display = "none";
    if (this.mainCpDisplay) this.mainCpDisplay.style.display = "none";
  }

  private restoreProgress(): void {
    try {
      const raw = window.localStorage.getItem("phaser-pond-progress");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { unlockedCount?: number; completed?: number[] };
      this.unlockedCount = Math.max(1, Math.min(this.store.getCount(), parsed.unlockedCount ?? 1));
      this.completed = new Set((parsed.completed ?? []).filter((v) => Number.isInteger(v)));
    } catch {
      this.unlockedCount = 1;
      this.completed.clear();
    }
  }

  private persistProgress(): void {
    window.localStorage.setItem(
      "phaser-pond-progress",
      JSON.stringify({
        unlockedCount: this.unlockedCount,
        completed: Array.from(this.completed.values()).sort((a, b) => a - b)
      })
    );
  }

  private hideWinScreen(): void {
    if (this.winScreen) this.winScreen.style.display = "none";
  }

  private showWinScreen(): void {
    if (this.winScreen) this.winScreen.style.display = "flex";
  }

  private advanceToNextLevel(): void {
    if (this.store.getIndex() + 1 < this.store.getCount()) {
      this.store.next();
      this.renderLevel();
      this.enterGameplay();
    } else {
      this.showMenu();
    }
  }

  private markCurrentLevelComplete(): void {
    const index = this.store.getIndex();
    this.completed.add(index);
    this.unlockedCount = Math.max(this.unlockedCount, Math.min(this.store.getCount(), index + 2));
    this.persistProgress();
    this.renderLevelList();
  }

  private onClearLevel(): void {
    if (this.levelClearHandled) return;
    this.levelClearHandled = true;
    this.markCurrentLevelComplete();
    this.showWinScreen();
  }

  private renderLevel(): void {
    const level = this.store.getCurrent();
    const width = this.scale.width;
    const height = this.scale.height;
    const isMobile = width <= MOBILE_BREAKPOINT;
    const safeTop = window.visualViewport ? Math.max(0, window.visualViewport.offsetTop) : 0;
    const topReserve = isMobile ? 18 + safeTop : 34;
    const bottomReserve = isMobile ? 78 : 52;
    const sidePadding = isMobile ? 14 : SIDE_PADDING;
    this.layout = buildLayout(
      width,
      height,
      level.rows,
      level.cols,
      topReserve,
      bottomReserve,
      sidePadding
    );
    this.currentLevel = level;
    this.fishes = level.gridFish.map((fish) => {
      const tail = getNodePosition(fish[0], fish[1], this.layout!);
      const head = getNodePosition(fish[2], fish[3], this.layout!);
      return {
        tailRow: fish[0],
        tailCol: fish[1],
        headRow: fish[2],
        headCol: fish[3],
        state: "idle",
        tailX: tail.x,
        tailY: tail.y,
        headX: head.x,
        headY: head.y,
        dirX: 0,
        dirY: 0,
        collisionDist: Number.POSITIVE_INFINITY,
        traveled: 0,
        fixedLengthPx: Math.max(
          this.layout!.cellSize,
          Math.round(Phaser.Math.Distance.Between(tail.x, tail.y, head.x, head.y) / this.layout!.cellSize) *
            this.layout!.cellSize
        )
      };
    });
    this.flyingGhosts = [];
    this.shells = (level.gridShells ?? []).map((s) => ({ row: s[0], col: s[1] }));
    this.selectedFishIndex = null;
    this.drag = null;
    this.levelClearHandled = false;
    this.hideWinScreen();
    this.renderRuntime();
    this.events.emit("level-change", level);
  }

  private renderRuntime(): void {
    if (!this.layout || !this.currentLevel) return;
    this.graphics.clear();
    this.drawNodes(this.currentLevel, this.layout);
    this.drawShells(this.layout);
    this.drawFish(this.layout);
  }

  private drawNodes(level: LevelData, layout: ReturnType<typeof buildLayout>): void {
    const radius = Math.max(6, layout.cellSize * 0.15);
    this.graphics.fillStyle(0xf6fffe, 0.86);
    this.graphics.lineStyle(2, 0x9fdff2, 0.85);
    for (let col = 0; col < level.cols; col += 1) {
      const rowCount = this.rowCountForCol(level.rows, col);
      for (let row = 0; row < rowCount; row += 1) {
        const point = getNodePosition(row, col, layout);
        this.graphics.fillCircle(point.x, point.y, radius);
        this.graphics.strokeCircle(point.x, point.y, radius);
      }
    }
  }

  private drawShells(layout: ReturnType<typeof buildLayout>): void {
    for (const shell of this.shells) {
      const p = getNodePosition(shell.row, shell.col, layout);
      const r = Math.max(7, layout.cellSize * 0.18);
      this.graphics.save();
      this.graphics.translateCanvas(p.x, p.y);
      this.graphics.fillStyle(0xe1b162, 0.98);
      this.graphics.lineStyle(2, 0x825129, 0.9);
      this.graphics.beginPath();
      this.graphics.arc(0, 0, r, Math.PI, Phaser.Math.PI2, false);
      this.graphics.lineTo(-r * 0.9, 0);
      this.graphics.closePath();
      this.graphics.fillPath();
      this.graphics.strokePath();

      this.graphics.lineStyle(1.2, 0xf6ddb0, 0.75);
      for (let i = -2; i <= 2; i += 1) {
        const x = (i / 2) * (r * 0.55);
        this.graphics.beginPath();
        this.graphics.moveTo(x, -r * 0.02);
        this.graphics.lineTo(x * 0.42, -r * 0.72);
        this.graphics.strokePath();
      }

      this.graphics.fillStyle(0xf6ddb0, 0.65);
      this.graphics.fillEllipse(0, -r * 0.35, r * 0.9, r * 0.4);
      this.graphics.restore();
    }
  }

  private drawFish(layout: ReturnType<typeof buildLayout>): void {
    const normalColor = 0xbe8453;
    const selectedColor = 0xd3965f;
    const outlineColor = 0x7a4d28;

    this.flyingGhosts.forEach((ghost) => {
      this.drawFishSegment(
        layout,
        { ax: ghost.tailX, ay: ghost.tailY, bx: ghost.headX, by: ghost.headY },
        normalColor,
        outlineColor,
        0.92
      );
    });

    this.fishes.forEach((fish, index) => {
      const segment = this.segmentForFish(fish);
      const fill = this.selectedFishIndex === index ? selectedColor : normalColor;
      this.drawFishSegment(layout, segment, fill, outlineColor, 1);
    });
  }

  private drawFishSegment(
    layout: ReturnType<typeof buildLayout>,
    segment: Segment,
    fillColor: number,
    outlineColor: number,
    alpha: number
  ): void {
    const angle = Phaser.Math.Angle.Between(segment.ax, segment.ay, segment.bx, segment.by);
    const length = Phaser.Math.Distance.Between(segment.ax, segment.ay, segment.bx, segment.by);
    const thickness = Math.max(11, layout.cellSize * 0.24);
    const headLength = Math.max(15, thickness * 1.08);
    const bodyEnd = Math.max(15, length - headLength);
    const headTip = bodyEnd + headLength;
    const headStart = bodyEnd - thickness * 0.08;
    // Tail-only fine tuning: keep coverage near 80% without changing head shape.
    const tailBack = Math.max(2, thickness * 0.34);

    this.graphics.save();
    this.graphics.translateCanvas(segment.ax, segment.ay);
    this.graphics.rotateCanvas(angle);

    const outline = [
      new Phaser.Math.Vector2(-tailBack, 0),
      new Phaser.Math.Vector2(Math.max(0.12, thickness * 0.2), -thickness * 0.76),
      new Phaser.Math.Vector2(thickness * 1.5, -thickness * 0.82),
      new Phaser.Math.Vector2(headStart, -thickness * 0.62),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.26, -thickness * 0.5),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.64, -thickness * 0.28),
      new Phaser.Math.Vector2(headTip, 0),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.64, thickness * 0.28),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.26, thickness * 0.5),
      new Phaser.Math.Vector2(headStart, thickness * 0.62),
      new Phaser.Math.Vector2(thickness * 1.5, thickness * 0.82),
      new Phaser.Math.Vector2(Math.max(0.12, thickness * 0.2), thickness * 0.76)
    ];

    this.graphics.fillStyle(fillColor, alpha);
    this.graphics.lineStyle(1.6, outlineColor, 0.9 * alpha);
    this.graphics.fillPoints(outline, true);
    this.graphics.strokePoints(outline, true, true);

    this.graphics.lineStyle(1.1, 0xf2c79a, 0.45 * alpha);
    this.graphics.beginPath();
    this.graphics.moveTo(thickness * 0.85, 0);
    this.graphics.lineTo(bodyEnd + headLength * 0.5, 0);
    this.graphics.strokePath();

    this.graphics.fillStyle(0x1e130d, 0.9 * alpha);
    this.graphics.fillCircle(bodyEnd + headLength * 0.36, 0, Math.max(2.2, thickness * 0.16));
    this.graphics.restore();
  }

  private pickFish(x: number, y: number): number | null {
    if (!this.layout) return null;
    const threshold = this.layout.cellSize * 0.4;
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.fishes.length; i += 1) {
      const fish = this.fishes[i];
      if (fish.state !== "idle") continue;
      const segment = this.segmentForFish(fish);
      const d = this.distancePointToSegment(x, y, segment.ax, segment.ay, segment.bx, segment.by);
      if (d < threshold && d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best >= 0 ? best : null;
  }

  private rotateFishByDrag(drag: DragState, x: number, y: number): boolean {
    if (!this.layout || !this.currentLevel) return false;
    const fish = this.fishes[drag.fishIndex];
    if (!fish || fish.state !== "idle") return false;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const len = this.fishLengthPx(fish);
    const targetAngle = Phaser.Math.Angle.Between(tail.x, tail.y, x, y);
    if (this.checkIncrementalSweep(drag.fishIndex, drag.lastAngle, targetAngle, len)) return false;

    this.setFishPreviewByAngle(fish, targetAngle, len);
    drag.lastAngle = targetAngle;
    drag.hoverHeadRow = null;
    drag.hoverHeadCol = null;

    const hover = this.findHoverRotationNode(drag.fishIndex, fish.headX, fish.headY);
    if (!hover) return true;

    const snapAngle = Phaser.Math.Angle.Between(tail.x, tail.y, hover.x, hover.y);
    if (this.checkIncrementalSweep(drag.fishIndex, drag.lastAngle, snapAngle, len)) return true;
    this.setFishPreviewByAngle(fish, snapAngle, len);
    drag.lastAngle = snapAngle;
    drag.hoverHeadRow = hover.row;
    drag.hoverHeadCol = hover.col;
    return true;
  }

  private fishLengthPx(fish: RuntimeFish): number {
    return fish.fixedLengthPx;
  }

  private setFishPreviewByAngle(fish: RuntimeFish, angle: number, len: number): void {
    if (!this.layout) return;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    fish.tailX = tail.x;
    fish.tailY = tail.y;
    fish.headX = tail.x + Math.cos(angle) * len;
    fish.headY = tail.y + Math.sin(angle) * len;
  }

  private findHoverRotationNode(fishIndex: number, headX: number, headY: number): NodeRef | null {
    if (!this.layout) return null;
    const fish = this.fishes[fishIndex];
    if (!fish) return null;
    // Match legacy HTML behavior: node hover radius is node radius + 10px.
    const snapRadius = this.layout.cellSize / 2.75 + 10;
    const candidates = this.rotationCandidatesForFish(fish);
    const isLongFish = Math.round(fish.fixedLengthPx / this.layout.cellSize) >= 4;
    const longFishMinReach = fish.fixedLengthPx - this.layout.cellSize * 0.1;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    for (const node of candidates) {
      if (!this.canPlaceFish(fishIndex, fish.tailRow, fish.tailCol, node.row, node.col)) continue;
      if (isLongFish) {
        const reach = Phaser.Math.Distance.Between(tail.x, tail.y, node.x, node.y);
        // Long fish cannot snap to effectively "shorter-than-self" nodes.
        if (reach + 1e-3 < longFishMinReach) continue;
      }
      const d = Phaser.Math.Distance.Between(headX, headY, node.x, node.y);
      if (d <= snapRadius) return node;
    }
    return null;
  }

  private checkIncrementalSweep(
    fishIndex: number,
    fromAngle: number,
    toAngle: number,
    len: number
  ): boolean {
    if (!this.layout) return false;
    const fish = this.fishes[fishIndex];
    if (!fish) return false;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const diff = Phaser.Math.Angle.Wrap(toAngle - fromAngle);
    const absDiff = Math.abs(diff);
    // Adaptive angular sampling prevents tunneling through blockers on fast drags.
    const steps = Math.max(8, Math.min(72, Math.ceil(absDiff / (Math.PI / 48))));
    for (let s = 1; s <= steps; s += 1) {
      const a = fromAngle + (diff * s) / steps;
      const hx = tail.x + Math.cos(a) * len;
      const hy = tail.y + Math.sin(a) * len;
      if (this.checkStaticCollisionSegment(tail.x, tail.y, hx, hy, fishIndex)) return true;
    }
    return false;
  }

  private checkStaticCollisionSegment(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    ignoreFishIndex: number
  ): boolean {
    if (!this.layout) return false;
    const fishRadius = this.layout.cellSize * 0.23;
    const shellRadius = this.layout.cellSize * 0.24;
    for (let i = 0; i < this.fishes.length; i += 1) {
      if (i === ignoreFishIndex) continue;
      const other = this.fishes[i];
      if (other.state !== "idle") continue;
      const seg = this.segmentForFish(other);
      if (this.lineSegmentsIntersect(ax, ay, bx, by, seg.ax, seg.ay, seg.bx, seg.by)) return true;
      if (this.distancePointToSegment(seg.ax, seg.ay, ax, ay, bx, by) < fishRadius) return true;
      if (this.distancePointToSegment(seg.bx, seg.by, ax, ay, bx, by) < fishRadius) return true;
      if (this.distancePointToSegment(ax, ay, seg.ax, seg.ay, seg.bx, seg.by) < fishRadius) return true;
      if (this.distancePointToSegment(bx, by, seg.ax, seg.ay, seg.bx, seg.by) < fishRadius) return true;
    }
    for (const shell of this.shells) {
      const p = getNodePosition(shell.row, shell.col, this.layout);
      if (this.distancePointToSegment(p.x, p.y, ax, ay, bx, by) < shellRadius) return true;
    }
    return false;
  }

  private tryRotateFishTowardPointer(fishIndex: number, x: number, y: number): boolean {
    if (!this.layout || !this.currentLevel) return false;
    const fish = this.fishes[fishIndex];
    if (!fish || fish.state !== "idle") return false;

    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const targetAngle = Phaser.Math.Angle.Between(tail.x, tail.y, x, y);
    const candidates = this.rotationCandidatesForFish(fish);
    if (candidates.length === 0) return false;

    let bestNode: NodeRef | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (const node of candidates) {
      const a = Phaser.Math.Angle.Between(tail.x, tail.y, node.x, node.y);
      const diff = Math.abs(Phaser.Math.Angle.Wrap(targetAngle - a));
      if (diff < bestDiff && this.canPlaceFish(fishIndex, fish.tailRow, fish.tailCol, node.row, node.col)) {
        bestDiff = diff;
        bestNode = node;
      }
    }

    if (!bestNode) return false;
    fish.headRow = bestNode.row;
    fish.headCol = bestNode.col;
    this.syncFishPoseToNodes(fish);
    return true;
  }

  private launchDistanceForFish(fishIndex: number): number {
    if (!this.layout) return Number.POSITIVE_INFINITY;
    const fish = this.fishes[fishIndex];
    if (!fish || fish.state !== "idle") return Number.POSITIVE_INFINITY;

    const segment = this.segmentForFish(fish);
    const dirX = segment.bx - segment.ax;
    const dirY = segment.by - segment.ay;
    const length = Math.hypot(dirX, dirY);
    if (length < 1e-6) return Number.POSITIVE_INFINITY;
    const nx = dirX / length;
    const ny = dirY / length;
    return this.firstBlockDistance(fishIndex, segment.bx + nx, segment.by + ny, nx, ny);
  }

  private launchResolvedFish(fishIndex: number): void {
    const fish = this.fishes[fishIndex];
    if (!fish || fish.state !== "idle") return;
    const segment = this.segmentForFish(fish);
    const dirX = segment.bx - segment.ax;
    const dirY = segment.by - segment.ay;
    const length = Math.hypot(dirX, dirY);
    if (length < 1e-6) return;
    const nx = dirX / length;
    const ny = dirY / length;
    this.flyingGhosts.push({
      tailX: segment.ax,
      tailY: segment.ay,
      headX: segment.bx,
      headY: segment.by,
      dirX: nx,
      dirY: ny
    });
    this.fishes.splice(fishIndex, 1);
  }

  private tryAutoLaunchAfterRotate(fishIndex: number): void {
    const fish = this.fishes[fishIndex];
    if (!fish || fish.state !== "idle") return;
    const blocked = this.launchDistanceForFish(fishIndex);
    if (blocked === Number.POSITIVE_INFINITY) this.launchResolvedFish(fishIndex);
  }

  private tryLaunchFishOnTap(fishIndex: number): void {
    const fish = this.fishes[fishIndex];
    if (!fish || fish.state !== "idle") return;
    const blocked = this.launchDistanceForFish(fishIndex);
    if (blocked === Number.POSITIVE_INFINITY) {
      this.launchResolvedFish(fishIndex);
      return;
    }
    const segment = this.segmentForFish(fish);
    const dirX = segment.bx - segment.ax;
    const dirY = segment.by - segment.ay;
    const length = Math.hypot(dirX, dirY);
    if (length < 1e-6) return;
    fish.state = "swimming";
    fish.dirX = dirX / length;
    fish.dirY = dirY / length;
    fish.collisionDist = blocked;
    fish.traveled = 0;
  }

  private firstBlockDistance(fishIndex: number, ax: number, ay: number, dx: number, dy: number): number {
    if (!this.layout) return Number.POSITIVE_INFINITY;
    const far = 4000;
    const bx = ax + dx * far;
    const by = ay + dy * far;
    const epsilon = 1e-3;
    let best = Number.POSITIVE_INFINITY;
    const fishRadius = this.layout.cellSize * 0.23;

    for (let i = 0; i < this.fishes.length; i += 1) {
      if (i === fishIndex) continue;
      const other = this.fishes[i];
      if (other.state !== "idle") continue;
      const seg = this.segmentForFish(other);
      const hit = this.raySegmentIntersection(ax, ay, bx, by, seg.ax, seg.ay, seg.bx, seg.by);
      if (hit !== null && hit > epsilon && hit < best) best = hit;

      // Endpoint capsule fallback prevents near-miss tunneling on thick fish bodies.
      const endA = this.rayCircleIntersection(ax, ay, dx, dy, seg.ax, seg.ay, fishRadius);
      const endB = this.rayCircleIntersection(ax, ay, dx, dy, seg.bx, seg.by, fishRadius);
      if (endA !== null && endA > epsilon && endA < best) best = endA;
      if (endB !== null && endB > epsilon && endB < best) best = endB;
    }

    const shellRadius = this.layout.cellSize * 0.24;
    for (const shell of this.shells) {
      const p = getNodePosition(shell.row, shell.col, this.layout);
      const t = this.rayCircleIntersection(ax, ay, dx, dy, p.x, p.y, shellRadius);
      if (t !== null && t > epsilon && t < best) best = t;
    }

    return best;
  }

  private rotationCandidatesForFish(fish: RuntimeFish): NodeRef[] {
    if (!this.layout || !this.currentLevel) return [];
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    // Match legacy HTML: target ring is based on rounded grid-length units.
    const lenUnits = Math.max(1, Math.round(fish.fixedLengthPx / this.layout.cellSize));
    const out: NodeRef[] = [];

    for (let col = 0; col < this.currentLevel.cols; col += 1) {
      const rowCount = this.rowCountForCol(this.currentLevel.rows, col);
      for (let row = 0; row < rowCount; row += 1) {
        if (row === fish.tailRow && col === fish.tailCol) continue;
        const node = getNodePosition(row, col, this.layout);
        const lenUnitsToNode = Math.round(
          Phaser.Math.Distance.Between(tail.x, tail.y, node.x, node.y) / this.layout.cellSize
        );
        if (lenUnitsToNode === lenUnits) {
          out.push({ row, col, x: node.x, y: node.y });
        }
      }
    }
    return out;
  }

  private canPlaceFish(
    fishIndex: number,
    tailRow: number,
    tailCol: number,
    headRow: number,
    headCol: number
  ): boolean {
    if (!this.layout) return false;
    const a = getNodePosition(tailRow, tailCol, this.layout);
    const target = getNodePosition(headRow, headCol, this.layout);
    const fish = this.fishes[fishIndex];
    const fixedLen = fish ? fish.fixedLengthPx : this.layout.cellSize;
    const angle = Phaser.Math.Angle.Between(a.x, a.y, target.x, target.y);
    const b = { x: a.x + Math.cos(angle) * fixedLen, y: a.y + Math.sin(angle) * fixedLen };
    const thickness = this.layout.cellSize * 0.23;
    const seg: Segment = { ax: a.x, ay: a.y, bx: b.x, by: b.y };

    for (let i = 0; i < this.fishes.length; i += 1) {
      if (i === fishIndex) continue;
      const other = this.fishes[i];
      if (other.state !== "idle") continue;
      // Endpoints are exclusive: different fish cannot share any node endpoint.
      if (
        (other.tailRow === tailRow && other.tailCol === tailCol) ||
        (other.tailRow === headRow && other.tailCol === headCol) ||
        (other.headRow === tailRow && other.headCol === tailCol) ||
        (other.headRow === headRow && other.headCol === headCol)
      ) {
        return false;
      }
      const o = this.segmentForFish(other);
      const d = this.segmentDistance(seg.ax, seg.ay, seg.bx, seg.by, o.ax, o.ay, o.bx, o.by);
      if (d < thickness) return false;
    }

    const shellRadius = this.layout.cellSize * 0.24;
    for (const shell of this.shells) {
      const p = getNodePosition(shell.row, shell.col, this.layout);
      const d = this.distancePointToSegment(p.x, p.y, seg.ax, seg.ay, seg.bx, seg.by);
      if (d < shellRadius) return false;
    }
    return true;
  }

  private segmentForFish(fish: RuntimeFish): Segment {
    return { ax: fish.tailX, ay: fish.tailY, bx: fish.headX, by: fish.headY };
  }

  private isGhostOffscreen(ghost: RuntimeGhost): boolean {
    if (!this.layout || !this.currentLevel) return false;
    const margin = this.layout.cellSize * 2.1;
    const minX = -margin;
    const maxX = this.scale.width + margin;
    const minY = -margin;
    const maxY = this.scale.height + margin;
    return ghost.headX < minX || ghost.headX > maxX || ghost.headY < minY || ghost.headY > maxY;
  }

  private syncFishPoseToNodes(fish: RuntimeFish): void {
    if (!this.layout) return;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const head = getNodePosition(fish.headRow, fish.headCol, this.layout);
    const angle = Phaser.Math.Angle.Between(tail.x, tail.y, head.x, head.y);
    fish.tailX = tail.x;
    fish.tailY = tail.y;
    fish.headX = tail.x + Math.cos(angle) * fish.fixedLengthPx;
    fish.headY = tail.y + Math.sin(angle) * fish.fixedLengthPx;
  }

  private movePointToward(
    fish: RuntimeFish,
    xKey: "tailX" | "headX",
    yKey: "tailY" | "headY",
    tx: number,
    ty: number,
    step: number
  ): boolean {
    const dx = tx - fish[xKey];
    const dy = ty - fish[yKey];
    const d = Math.hypot(dx, dy);
    if (d <= step || d < 1e-3) {
      fish[xKey] = tx;
      fish[yKey] = ty;
      return true;
    }
    fish[xKey] += (dx / d) * step;
    fish[yKey] += (dy / d) * step;
    return false;
  }

  private rowCountForCol(rows: number, col: number): number {
    return col % 2 === 0 ? rows : rows - 1;
  }

  private distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const vv = vx * vx + vy * vy;
    if (vv < 1e-6) return Math.hypot(px - ax, py - ay);
    const t = Phaser.Math.Clamp((wx * vx + wy * vy) / vv, 0, 1);
    const qx = ax + vx * t;
    const qy = ay + vy * t;
    return Math.hypot(px - qx, py - qy);
  }

  private segmentDistance(
    a1x: number,
    a1y: number,
    a2x: number,
    a2y: number,
    b1x: number,
    b1y: number,
    b2x: number,
    b2y: number
  ): number {
    if (this.lineSegmentsIntersect(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y)) return 0;
    return Math.min(
      this.distancePointToSegment(a1x, a1y, b1x, b1y, b2x, b2y),
      this.distancePointToSegment(a2x, a2y, b1x, b1y, b2x, b2y),
      this.distancePointToSegment(b1x, b1y, a1x, a1y, a2x, a2y),
      this.distancePointToSegment(b2x, b2y, a1x, a1y, a2x, a2y)
    );
  }

  private lineSegmentsIntersect(
    a1x: number,
    a1y: number,
    a2x: number,
    a2y: number,
    b1x: number,
    b1y: number,
    b2x: number,
    b2y: number
  ): boolean {
    const d = (a2x - a1x) * (b2y - b1y) - (a2y - a1y) * (b2x - b1x);
    if (Math.abs(d) < 1e-6) return false;
    const u = ((b1x - a1x) * (b2y - b1y) - (b1y - a1y) * (b2x - b1x)) / d;
    const v = ((b1x - a1x) * (a2y - a1y) - (b1y - a1y) * (a2x - a1x)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }

  private raySegmentIntersection(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    sx: number,
    sy: number,
    ex: number,
    ey: number
  ): number | null {
    const rdx = bx - ax;
    const rdy = by - ay;
    const sdx = ex - sx;
    const sdy = ey - sy;
    const det = rdx * sdy - rdy * sdx;
    const ux = sx - ax;
    const uy = sy - ay;

    // Parallel case: treat collinear overlap as blocking, otherwise no hit.
    if (Math.abs(det) < 1e-6) {
      const cross = ux * rdy - uy * rdx;
      if (Math.abs(cross) > 1e-6) return null;

      const rayLen = Math.hypot(rdx, rdy);
      if (rayLen < 1e-6) return null;
      const dirX = rdx / rayLen;
      const dirY = rdy / rayLen;
      const t0 = ux * dirX + uy * dirY;
      const t1 = (ex - ax) * dirX + (ey - ay) * dirY;
      const near = Math.min(t0, t1);
      const farProj = Math.max(t0, t1);
      if (farProj < 0) return null;
      return near >= 0 ? near : 0;
    }

    const t = (ux * sdy - uy * sdx) / det;
    const u = (ux * rdy - uy * rdx) / det;
    if (t < 0 || u < 0 || u > 1) return null;
    return t * Math.hypot(rdx, rdy);
  }

  private rayCircleIntersection(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    cx: number,
    cy: number,
    radius: number
  ): number | null {
    const vx = cx - ox;
    const vy = cy - oy;
    const proj = vx * dx + vy * dy;
    if (proj < 0) return null;
    const perp2 = vx * vx + vy * vy - proj * proj;
    const r2 = radius * radius;
    if (perp2 > r2) return null;
    const hit = proj - Math.sqrt(r2 - perp2);
    return hit >= 0 ? hit : null;
  }
}
