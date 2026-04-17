import Phaser from "phaser";
import { MOBILE_BREAKPOINT, SIDE_PADDING } from "../core/config";
import { buildLayout, getNodePosition } from "../game/geometry";
import { LevelStore } from "../systems/LevelStore";
import type { LevelData } from "../types/level";

interface RuntimeFish {
  id: string;
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

interface HintFish {
  id: string;
  tailRow: number;
  tailCol: number;
  headRow: number;
  headCol: number;
  fixedLengthPx: number;
}

interface HintAction {
  fishKey: string;
  tailRow: number;
  tailCol: number;
  headRow: number;
  headCol: number;
  kind: "launch" | "rotate";
}

interface HintPlayback {
  startedAt: number;
  stepDurationMs: number;
  steps: HintVisualStep[];
  loop: boolean;
}

interface HintVisualStep {
  kind: "launch" | "rotate";
  tailX: number;
  tailY: number;
  fromHeadX: number;
  fromHeadY: number;
  toHeadX: number;
  toHeadY: number;
}

interface HintSearchNode {
  state: HintFish[];
  plan: HintAction[];
  depth: number;
}

interface HintSearchTask {
  key: string;
  initialState: HintFish[];
  attempts: number;
  startedAt: number;
  deadlineAt: number;
  queue: HintSearchNode[];
  head: number;
  visited: Map<string, number>;
  expanded: number;
  maxDepth: number;
  nodeBudget: number;
  bestFallback: HintAction[] | null;
  timedOut: boolean;
  done: boolean;
  result: HintAction[] | null;
}

interface HintStateSpatialIndex {
  fishSegments: Segment[];
  fishBuckets: Map<string, number[]>;
  bucketCell: number;
}

export class GameScene extends Phaser.Scene {
  private readonly hintAsyncDeadlineMs = 30000;
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
  private hintButton: HTMLElement | null = null;
  private hintWaitOverlay: HTMLElement | null = null;
  private hintStepLabel: Phaser.GameObjects.Text | null = null;

  private layout: ReturnType<typeof buildLayout> | null = null;
  private currentLevel: LevelData | null = null;
  private fishes: RuntimeFish[] = [];
  private flyingGhosts: RuntimeGhost[] = [];
  private shells: RuntimeShell[] = [];
  private drag: DragState | null = null;
  private selectedFishIndex: number | null = null;
  private hintPlayback: HintPlayback | null = null;
  private hintCache = new Map<string, HintAction[] | null>();
  private hintSearchAttempts = new Map<string, number>();
  private pendingHintTask: HintSearchTask | null = null;
  private pendingHintRequestKey: string | null = null;
  private levelClearHandled = false;
  private hintTraceSeq = 0;
  private currentHintTraceId = 0;
  private recentHintActions: HintAction[] = [];
  private hintBusy = false;
  private rotationRingCache = new Map<string, NodeRef[]>();
  private hintStateSpatialCache = new WeakMap<HintFish[], HintStateSpatialIndex>();
  private shellSpatialBuckets = new Map<string, NodeRef[]>();
  private shellSpatialCell = 0;

  constructor() {
    super("game");
  }

  create(): void {
    this.graphics = this.add.graphics();
    this.hintStepLabel = this.add
      .text(0, 0, "", {
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        fontSize: "12px",
        color: "#1f1f1f",
        fontStyle: "700"
      })
      .setDepth(4600)
      .setVisible(false)
      .setPadding(6, 3, 6, 3)
      .setBackgroundColor("rgba(255,255,255,0.78)");
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
    this.tickHintPlayback();
    this.tickHintSearch();
    // Hint playback is time-based animation; keep rendering frames even when
    // no fish/ghost state changed, otherwise loop mode appears frozen.
    if (this.hintPlayback) changed = true;

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
    this.hintButton = document.getElementById("hint-level");
    this.hintWaitOverlay = document.getElementById("hint-wait-overlay");
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
    const hintLevel = document.getElementById("hint-level");
    const backToMenu = document.getElementById("back-to-menu");
    const hintWaitClose = document.getElementById("hint-wait-close");

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
      this.hideWinScreen();
      this.showMenu();
    });
    resetLevel?.addEventListener("click", () => {
      this.hintPlayback = null;
      this.hideWinScreen();
      this.renderLevel();
      this.enterGameplay();
      this.setEditorStatus("当前关卡已重置。");
    });
    hintLevel?.addEventListener("click", () => {
      this.requestHint();
    });
    hintWaitClose?.addEventListener("click", () => {
      this.cancelHintSearchByUser();
    });
    backToMenu?.addEventListener("click", () => {
      this.hintPlayback = null;
      this.hideWinScreen();
      this.showMenu();
    });
  }

  private bindInput(): void {
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.layout || !this.currentLevel) return;
      if (this.levelsPanel?.style.display === "flex" || this.editorPanel?.style.display === "flex") return;
      if (this.fishes.some((fish) => fish.state !== "idle")) return;
      this.hintPlayback = null;
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
    this.hintPlayback = null;
    this.hideHintStepLabel();
    this.pendingHintTask = null;
    this.pendingHintRequestKey = null;
    this.setHintBusy(false);
    if (this.levelsPanel) this.levelsPanel.style.display = "flex";
    if (this.editorPanel) this.editorPanel.style.display = "none";
    if (this.gameControls) this.gameControls.style.display = "none";
    if (this.editorToggle) this.editorToggle.style.display = "inline-flex";
    if (this.headerContainer) this.headerContainer.style.display = "block";
    if (this.mainCpDisplay) this.mainCpDisplay.style.display = "flex";
    this.hideHintStepLabel();
  }

  private showEditor(): void {
    this.hintPlayback = null;
    this.pendingHintTask = null;
    this.pendingHintRequestKey = null;
    this.setHintBusy(false);
    if (this.editorPanel) this.editorPanel.style.display = "flex";
    if (this.levelsPanel) this.levelsPanel.style.display = "none";
    if (this.gameControls) this.gameControls.style.display = "none";
    if (this.editorToggle) this.editorToggle.style.display = "none";
    if (this.headerContainer) this.headerContainer.style.display = "block";
    if (this.mainCpDisplay) this.mainCpDisplay.style.display = "flex";
    this.syncEditor(this.store.getCurrent());
    this.hideHintStepLabel();
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
    this.setHintBusy(false);
    this.recentHintActions = [];
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

  private requestHint(): void {
    if (!this.layout) return;
    if (this.fishes.length === 0) return;
    if (this.fishes.some((fish) => fish.state !== "idle")) return;
    if (this.pendingHintTask && !this.pendingHintTask.done) {
      this.pushHintLog("request ignored: hint search running");
      return;
    }
    this.currentHintTraceId = ++this.hintTraceSeq;
    const initial = this.captureHintState();
    if (initial.length === 0) return;
    let launchable = 0;
    for (let i = 0; i < initial.length; i += 1) {
      const ld = this.launchDistanceForHintState(initial, i);
      if (ld === Number.POSITIVE_INFINITY) launchable += 1;
    }
    this.pushHintLog(`request fishes=${initial.length} launchable=${launchable}`);
    const key = this.hintCacheKey(initial);
    const attempts = (this.hintSearchAttempts.get(key) ?? 0) + 1;
    this.hintSearchAttempts.set(key, attempts);
    if (this.hintSearchAttempts.size > 512) this.hintSearchAttempts.clear();
    this.pushHintLog(`request attempts=${attempts}`);
    const cached = this.hintCache.get(key) ?? null;
    if (cached && cached.length > 0 && this.validateHintPlan(initial, cached) && this.planEndsWithLaunch(cached)) {
      this.pushHintLog(`cache hit plan=${this.formatHintPlan(cached)}`);
      this.setHintBusy(false);
      this.presentHintPlan(cached);
      return;
    }
    if (cached && cached.length > 0) {
      this.pushHintLog(`cache bypassed plan=${this.formatHintPlan(cached)}`);
    }
    const direct = this.pickFirstLaunchAction(initial);
    if (direct) {
      this.pushHintLog(`layer1 direct launch=${this.formatHintAction(direct)}`);
      this.setHintBusy(false);
      this.presentHintPlan([direct]);
      return;
    }
    this.pushHintLog("layer1 direct launch miss");

    const oneStep = this.findOneRotateThenLaunchPlan(initial);
    if (oneStep && this.validateHintPlan(initial, oneStep)) {
      this.pushHintLog(`layer2 rotate+launch hit plan=${this.formatHintPlan(oneStep)}`);
      this.setHintBusy(false);
      this.presentHintPlan(oneStep);
      return;
    }
    this.pushHintLog("layer2 rotate+launch miss");

    // Layer3 runs incrementally across frames to avoid blocking interaction.
    const complexity = Math.max(0, initial.length - 36);
    const depthBoost = Math.floor((attempts - 1) / 3);
    const maxDepth = Math.min(13, Math.max(8, Math.ceil(initial.length * 0.34) + 2 + depthBoost));
    const nodeBudget = Math.min(90000, 22000 + complexity * 1800 + (attempts - 1) * 6000);
    const now = performance.now();
    const task: HintSearchTask = {
      key,
      initialState: initial.map((f) => ({ ...f })),
      attempts,
      startedAt: now,
      deadlineAt: now + this.hintAsyncDeadlineMs,
      queue: [{ state: initial.map((f) => ({ ...f })), plan: [], depth: 0 }],
      head: 0,
      visited: new Map<string, number>([[this.serializeHintState(initial), 0]]),
      expanded: 0,
      maxDepth,
      nodeBudget,
      bestFallback: null,
      timedOut: false,
      done: false,
      result: null
    };
    this.pendingHintTask = task;
    this.pendingHintRequestKey = key;
    this.setHintBusy(true);
    this.pushHintLog(
      `layer3 async start attempts=${attempts} maxDepth=${maxDepth} nodeBudget=${nodeBudget} deadlineMs=${this.hintAsyncDeadlineMs}`
    );
  }

  private trimHintCache(maxSize = 256): void {
    if (this.hintCache.size <= maxSize) return;
    const keys = this.hintCache.keys();
    while (this.hintCache.size > maxSize) {
      const first = keys.next();
      if (first.done) break;
      this.hintCache.delete(first.value);
    }
  }

  private hintCacheKey(state: HintFish[]): string {
    const levelId = this.store.getIndex();
    const shellSig = this.shells.map((s) => `${s.row},${s.col}`).sort().join(";");
    return `L${levelId}|S${shellSig}|${this.serializeHintState(state)}`;
  }

  private findFirstValidHintPlan(initial: HintFish[], attempts = 1): HintAction[] | null {
    const direct = this.pickFirstLaunchAction(initial);
    if (direct) {
      this.pushHintLog(`layer1 direct launch=${this.formatHintAction(direct)}`);
      return [direct];
    }
    this.pushHintLog("layer1 direct launch miss");

    const oneStep = this.findOneRotateThenLaunchPlan(initial);
    if (oneStep && this.validateHintPlan(initial, oneStep)) {
      this.pushHintLog(`layer2 rotate+launch hit plan=${this.formatHintPlan(oneStep)}`);
      return oneStep;
    }
    this.pushHintLog("layer2 rotate+launch miss");

    const baseMaxDepth = Math.min(9, Math.max(3, Math.ceil(initial.length * 0.34) + 1));
    const complexity = Math.max(0, initial.length - 36);
    const baseNodeBudget = Math.min(5200, 2000 + complexity * 150);
    const baseTimeBudgetMs = Math.min(72, 24 + complexity * 1.2);
    const searchScale = 1 + Math.min(4, Math.max(0, attempts - 1)) * 0.85;
    const maxDepth = Math.min(12, baseMaxDepth + Math.floor((attempts - 1) / 2));
    const nodeBudget = Math.min(24000, Math.floor(baseNodeBudget * searchScale));
    const timeBudgetMs = Math.min(220, baseTimeBudgetMs * searchScale);
    const branchLimit = Math.min(28, 16 + Math.floor((attempts - 1) / 2) * 2);
    const t0 = performance.now();
    let expanded = 0;
    let timedOut = false;
    this.pushHintLog(
      `layer3 iddfs start attempts=${attempts} scale=${searchScale.toFixed(2)} maxDepth=${maxDepth} nodeBudget=${nodeBudget} timeBudgetMs=${timeBudgetMs.toFixed(1)} branchLimit=${branchLimit}`
    );
    const bestDepth = new Map<string, number>();
    bestDepth.set(this.serializeHintState(initial), 0);

    const dfs = (state: HintFish[], plan: HintAction[], depthLeft: number): HintAction[] | null => {
      if (performance.now() - t0 >= timeBudgetMs) {
        timedOut = true;
        return null;
      }
      if (expanded >= nodeBudget) return null;
      expanded += 1;

      const launch = this.pickFirstLaunchAction(state);
      if (launch) return plan.concat(launch);
      if (depthLeft <= 0) return null;
      if (this.isHintDeadState(state)) return null;

      const rotates = this.generateRotateActions(state).slice(0, branchLimit);
      for (const action of rotates) {
        if (this.isImmediateReverseRotate(plan, action)) continue;
        const next = this.applyHintAction(state, action);
        const key = this.serializeHintState(next);
        const g = plan.length + 1;
        const prev = bestDepth.get(key);
        if (prev !== undefined && prev <= g) continue;
        bestDepth.set(key, g);
        const found = dfs(next, plan.concat(action), depthLeft - 1);
        if (found) return found;
        if (timedOut) return null;
      }
      return null;
    };

    for (let d = 1; d <= maxDepth; d += 1) {
      const plan = dfs(initial.map((f) => ({ ...f })), [], d);
      if (plan && this.validateHintPlan(initial, plan)) {
        this.pushHintLog(
          `layer3 depth=${d} hit expanded=${expanded} elapsedMs=${(performance.now() - t0).toFixed(2)} plan=${this.formatHintPlan(plan)}`
        );
        return plan;
      }
      if (timedOut) break;
    }
    this.pushHintLog(`layer3 miss expanded=${expanded} elapsedMs=${(performance.now() - t0).toFixed(2)} timeout=${timedOut}`);

    this.pushHintLog("fallback none (launch-goal mode)");
    return null;
  }

  private pickFirstLaunchAction(state: HintFish[]): HintAction | null {
    const launches = this.generateLaunchActions(state);
    return launches.length > 0 ? launches[0] : null;
  }

  private findOneRotateThenLaunchPlan(initial: HintFish[]): HintAction[] | null {
    const rotates = this.generateRotateActions(initial).slice(0, 18);
    this.pushHintLog(`layer2 candidates=${rotates.length}`);
    for (const rotate of rotates) {
      const next = this.applyHintAction(initial, rotate);
      const launch = this.pickFirstLaunchAction(next);
      if (!launch) continue;
      this.pushHintLog(`layer2 candidate hit rotate=${this.formatHintAction(rotate)} then launch=${this.formatHintAction(launch)}`);
      return [rotate, launch];
    }
    return null;
  }

  private isImmediateReverseRotate(plan: HintAction[], next: HintAction): boolean {
    const last = plan[plan.length - 1];
    if (!last || last.kind !== "rotate" || next.kind !== "rotate") return false;
    if (last.fishKey !== next.fishKey) return false;
    return last.headRow === next.tailRow && last.headCol === next.tailCol;
  }

  private findBestRotateOnlyHintAction(state: HintFish[]): HintAction | null {
    const rotates = this.generateRotateActions(state).slice(0, 20);
    if (rotates.length === 0) return null;
    const base = this.evaluateHintStateProgress(state);
    let best: HintAction | null = null;
    let bestScore = -1e9;
    for (const action of rotates) {
      const next = this.applyHintAction(state, action);
      const cur = this.evaluateHintStateProgress(next);
      // Prefer actions that create immediate launch opportunities for any fish.
      const launchGain = (cur.launchable - base.launchable) * 1000;
      // Then prefer reducing nearest blocker distance.
      const distanceGain =
        Number.isFinite(base.minFinite) && Number.isFinite(cur.minFinite) ? base.minFinite - cur.minFinite : 0;
      // Smaller rotation displacement is slightly preferred when benefit equals.
      const turnPenalty =
        Math.abs(cur.bestAngleDelta) > 0 && Number.isFinite(cur.bestAngleDelta) ? Math.abs(cur.bestAngleDelta) * 0.03 : 0;
      const score = launchGain + distanceGain - turnPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = action;
      }
    }
    if (!best) return null;
    // If no measurable progress, avoid returning a "meaningless" rotate hint.
    if (bestScore < -0.2) {
      this.pushHintLog(`fallback rotate rejected: regressive score=${bestScore.toFixed(2)}`);
      return null;
    }
    if (bestScore <= 0.05) {
      this.pushHintLog(`fallback rotate low-progress accepted score=${bestScore.toFixed(2)} action=${this.formatHintAction(best)}`);
      return best;
    }
    this.pushHintLog(`fallback rotate accepted score=${bestScore.toFixed(2)} action=${this.formatHintAction(best)}`);
    return best;
  }

  private evaluateHintStateProgress(state: HintFish[]): { launchable: number; minFinite: number; bestAngleDelta: number } {
    let launchable = 0;
    let minFinite = Number.POSITIVE_INFINITY;
    for (let i = 0; i < state.length; i += 1) {
      const ld = this.launchDistanceForHintState(state, i);
      if (ld === Number.POSITIVE_INFINITY) launchable += 1;
      else if (ld < minFinite) minFinite = ld;
    }
    // Placeholder for tie-break consistency. Keep 0 for now.
    return { launchable, minFinite, bestAngleDelta: 0 };
  }

  private isHintDeadState(state: HintFish[]): boolean {
    if (state.length === 0) return false;
    if (this.generateLaunchActions(state).length > 0) return false;
    for (let i = 0; i < state.length; i += 1) {
      const fish = state[i];
      const candidates = this.rotationCandidatesForHintFish(fish);
      for (const node of candidates) {
        if (this.checkHintIncrementalSweep(state, i, node.row, node.col)) continue;
        if (!this.canPlaceHintFishState(state, i, node.row, node.col)) continue;
        return false;
      }
    }
    return true;
  }

  private tickHintSearch(): void {
    const task = this.pendingHintTask;
    if (!task || task.done) return;

    if (performance.now() >= task.deadlineAt) {
      task.timedOut = true;
      task.done = true;
    }
    if (task.done) {
      this.finishHintSearchTask(task);
      return;
    }

    const startTs = performance.now();
    const frameBudgetMs = 5.2;
    const maxNodesPerTick = 140;
    let nodes = 0;

    while (
      task.head < task.queue.length &&
      task.expanded < task.nodeBudget &&
      nodes < maxNodesPerTick &&
      performance.now() - startTs < frameBudgetMs
    ) {
      const item = task.queue[task.head++];
      task.expanded += 1;
      nodes += 1;

      if (item.depth >= task.maxDepth) continue;

      const launches = this.generateLaunchActions(item.state);
      if (launches.length > 0) {
        const candidatePlan = item.plan.concat(launches[0]);
        if (this.validateHintPlan(task.initialState, candidatePlan)) {
          task.result = candidatePlan;
          task.done = true;
          break;
        }
      }

      const rotateActions = this.generateRotateActions(item.state);
      if (!task.bestFallback && rotateActions.length > 0) {
        task.bestFallback = item.plan.concat(rotateActions[0]);
      }

      for (const action of rotateActions) {
        const nextState = this.applyHintAction(item.state, action);
        const nextPlan = item.plan.concat(action);
        const stateKey = this.serializeHintState(nextState);
        const prevDepth = task.visited.get(stateKey);
        if (prevDepth !== undefined && prevDepth <= item.depth + 1) continue;
        task.visited.set(stateKey, item.depth + 1);
        task.queue.push({ state: nextState, plan: nextPlan, depth: item.depth + 1 });
      }
    }

    if (!task.done && (task.head >= task.queue.length || task.expanded >= task.nodeBudget)) {
      if (task.bestFallback && this.validateHintPlan(task.initialState, task.bestFallback)) {
        task.result = task.bestFallback;
      }
      task.done = true;
    }

    if (!task.done) return;
    this.finishHintSearchTask(task);
  }

  private finishHintSearchTask(task: HintSearchTask): void {
    const elapsed = performance.now() - task.startedAt;
    if (task.timedOut) {
      this.pushHintLog(`layer3 async timeout elapsedMs=${elapsed.toFixed(1)} expanded=${task.expanded}`);
    } else {
      this.pushHintLog(`layer3 async done elapsedMs=${elapsed.toFixed(1)} expanded=${task.expanded}`);
    }
    const plan = this.normalizeHintPlanForLaunchGoal(task.result ?? []);
    this.pendingHintTask = null;
    this.pendingHintRequestKey = null;
    this.setHintBusy(false);
    if (!plan || plan.length === 0) {
      const fallback = this.findExecutableFallbackAction();
      if (!fallback) {
        this.pushHintLog("solver returned empty plan (no hint presented)");
        return;
      }
      this.pushHintLog(`fallback executable action=${this.formatHintAction(fallback)}`);
      this.presentHintPlan([fallback]);
      return;
    }
    this.pushHintLog(`solver plan=${this.formatHintPlan(plan)}`);
    const firstScore = this.actionProgressScore(plan[0]);
    if (this.shouldCacheHintPlan(plan, firstScore)) {
      this.hintCache.set(task.key, plan);
      this.trimHintCache();
      this.hintSearchAttempts.delete(task.key);
    } else {
      this.pushHintLog(`cache skipped low-gain firstScore=${firstScore.toFixed(2)}`);
    }
    this.presentHintPlan(plan);
  }

  private setHintBusy(busy: boolean): void {
    this.hintBusy = busy;
    if (this.hintWaitOverlay) this.hintWaitOverlay.style.display = busy ? "flex" : "none";
    if (!this.hintButton) return;
    this.hintButton.textContent = busy ? "提示计算中…" : "提示";
    this.hintButton.toggleAttribute("disabled", busy);
    this.hintButton.setAttribute("aria-busy", busy ? "true" : "false");
  }

  private cancelHintSearchByUser(): void {
    const task = this.pendingHintTask;
    if (!task || task.done) {
      this.setHintBusy(false);
      return;
    }
    this.pushHintLog(
      `hint search canceled by user elapsedMs=${(performance.now() - task.startedAt).toFixed(1)} expanded=${task.expanded}`
    );
    this.pendingHintTask = null;
    this.pendingHintRequestKey = null;
    this.setHintBusy(false);
  }

  private presentHintPlan(plan: HintAction[]): void {
    if (!plan || plan.length === 0) return;
    const launchPlan = this.normalizeHintPlanForLaunchGoal(plan);
    if (!launchPlan || launchPlan.length === 0) {
      this.pushHintLog("present skipped: plan has no launch goal");
      return;
    }
    if (!this.isFirstHintActionExecutable(launchPlan[0])) {
      this.pushHintLog(`present skipped: first step not executable action=${this.formatHintAction(launchPlan[0])}`);
      return;
    }
    this.pushHintLog(`present plan=${this.formatHintPlan(launchPlan)}`);
    let visuals = this.buildHintVisualSteps(launchPlan);
    if (visuals.length === 0) {
      this.pushHintLog("visual build failed for plan");
      return;
    }
    this.hintPlayback = {
      startedAt: this.time.now,
      stepDurationMs: 760,
      steps: visuals,
      loop: true
    };
    this.recordPresentedHintAction(launchPlan[0]);
    this.renderRuntime();
  }

  private recordPresentedHintAction(action: HintAction): void {
    this.recentHintActions.push({ ...action });
    if (this.recentHintActions.length > 8) this.recentHintActions.shift();
  }

  private sameHintAction(a: HintAction, b: HintAction): boolean {
    return (
      a.kind === b.kind &&
      a.fishKey === b.fishKey &&
      a.tailRow === b.tailRow &&
      a.tailCol === b.tailCol &&
      a.headRow === b.headRow &&
      a.headCol === b.headCol
    );
  }

  private isInverseRotate(a: HintAction, b: HintAction): boolean {
    if (a.kind !== "rotate" || b.kind !== "rotate") return false;
    if (a.fishKey !== b.fishKey) return false;
    return a.tailRow === b.headRow && a.tailCol === b.headCol && a.headRow === b.tailRow && a.headCol === b.tailCol;
  }

  private actionProgressScore(action: HintAction): number {
    const state = this.captureHintState();
    if (state.length === 0) return 0;
    const idx = state.findIndex((f) => f.id === action.fishKey);
    if (idx < 0) return -9999;
    if (action.kind === "launch") {
      return this.launchDistanceForHintState(state, idx) === Number.POSITIVE_INFINITY ? 9999 : -9999;
    }
    const base = this.evaluateHintStateProgress(state);
    const next = this.applyHintAction(state, action);
    const cur = this.evaluateHintStateProgress(next);
    const launchGain = (cur.launchable - base.launchable) * 1000;
    const distanceGain =
      Number.isFinite(base.minFinite) && Number.isFinite(cur.minFinite) ? base.minFinite - cur.minFinite : 0;
    return launchGain + distanceGain;
  }

  private isRepetitiveLowGainAction(action: HintAction): boolean {
    const n = this.recentHintActions.length;
    if (n === 0) return false;
    const last = this.recentHintActions[n - 1];
    const score = this.actionProgressScore(action);
    if (this.sameHintAction(action, last) && score <= 0.1) return true;
    if (this.isInverseRotate(action, last) && score <= 0.1) return true;
    if (n >= 2) {
      const prev2 = this.recentHintActions[n - 2];
      if (this.sameHintAction(action, prev2) && this.isInverseRotate(last, prev2) && score <= 0.2) return true;
    }
    if (action.kind === "rotate" && score <= 0.15) {
      const recentSameFish = this.recentHintActions
        .slice(Math.max(0, n - 5))
        .filter((x) => x.kind === "rotate" && x.fishKey === action.fishKey);
      if (recentSameFish.length >= 2) {
        const headSet = new Set<string>();
        for (const x of recentSameFish) headSet.add(`${x.headRow},${x.headCol}`);
        headSet.add(`${action.headRow},${action.headCol}`);
        if (headSet.size <= 3) return true;
      }
    }
    return false;
  }

  private shouldCacheHintPlan(plan: HintAction[], firstScore: number): boolean {
    if (!plan || plan.length === 0) return false;
    if (!this.planEndsWithLaunch(plan)) return false;
    const first = plan[0];
    if (first.kind === "launch") return true;
    // For launch-target plans, allow caching when the opening rotation is non-regressive.
    return firstScore > -0.1;
  }

  private planEndsWithLaunch(plan: HintAction[]): boolean {
    return !!plan.length && plan[plan.length - 1].kind === "launch";
  }

  private normalizeHintPlanForLaunchGoal(plan: HintAction[]): HintAction[] | null {
    if (!plan || plan.length === 0) return null;
    const launchIdx = plan.findIndex((x) => x.kind === "launch");
    if (launchIdx < 0) return null;
    return plan.slice(0, launchIdx + 1);
  }

  private findAlternativeHintAction(rejected: HintAction): HintAction | null {
    const state = this.captureHintState();
    if (state.length === 0) return null;
    const launches = this.generateLaunchActions(state);
    for (const action of launches) {
      if (this.sameHintAction(action, rejected)) continue;
      if (!this.isFirstHintActionExecutable(action)) continue;
      if (this.isRepetitiveLowGainAction(action)) continue;
      return action;
    }
    const rotates = this.generateRotateActions(state).slice(0, 24);
    for (const action of rotates) {
      if (this.sameHintAction(action, rejected)) continue;
      if (!this.isFirstHintActionExecutable(action)) continue;
      if (this.isRepetitiveLowGainAction(action)) continue;
      return action;
    }
    return null;
  }

  private tickHintPlayback(): void {
    if (!this.hintPlayback) return;
    if (this.hintPlayback.loop) return;
    const elapsed = this.time.now - this.hintPlayback.startedAt;
    const total = this.hintPlayback.steps.length * this.hintPlayback.stepDurationMs;
    if (elapsed >= total) this.hintPlayback = null;
  }

  private drawHintOverlay(layout: ReturnType<typeof buildLayout>): void {
    const playback = this.hintPlayback;
    if (!playback || playback.steps.length === 0) {
      this.hideHintStepLabel();
      return;
    }
    const elapsed = this.time.now - playback.startedAt;
    const total = playback.steps.length * playback.stepDurationMs;
    const loopElapsed = playback.loop ? ((elapsed % total) + total) % total : elapsed;
    const idx = Math.floor(loopElapsed / playback.stepDurationMs);
    if (idx < 0 || idx >= playback.steps.length) {
      this.hideHintStepLabel();
      return;
    }
    const step = playback.steps[idx];
    const local = (loopElapsed % playback.stepDurationMs) / playback.stepDurationMs;

    this.graphics.save();
    const glowAlpha = 0.24 + Math.sin(local * Math.PI) * 0.22;
    const interpHeadX = Phaser.Math.Linear(step.fromHeadX, step.toHeadX, local);
    const interpHeadY = Phaser.Math.Linear(step.fromHeadY, step.toHeadY, local);

    // Soft blur trail: multiple translucent ghost fish silhouettes.
    const trailCount = step.kind === "launch" ? 6 : 5;
    for (let i = 0; i < trailCount; i += 1) {
      const t = Math.max(0, local - i * 0.11);
      const gx = Phaser.Math.Linear(step.fromHeadX, step.toHeadX, t);
      const gy = Phaser.Math.Linear(step.fromHeadY, step.toHeadY, t);
      const a = (step.kind === "launch" ? 0.16 : 0.12) * (1 - i / (trailCount + 1));
      this.drawFishSegment(
        layout,
        { ax: step.tailX, ay: step.tailY, bx: gx, by: gy },
        step.kind === "launch" ? 0x9de2ff : 0x8ee0a0,
        0xffffff,
        a
      );
    }

    this.graphics.lineStyle(Math.max(3, layout.cellSize * 0.12), 0x6acaf4, 0.72);
    this.graphics.strokeLineShape(new Phaser.Geom.Line(step.tailX, step.tailY, step.toHeadX, step.toHeadY));
    this.graphics.lineStyle(Math.max(2, layout.cellSize * 0.08), 0xffffff, 0.42);
    this.graphics.strokeLineShape(new Phaser.Geom.Line(step.tailX, step.tailY, step.toHeadX, step.toHeadY));

    if (step.kind !== "launch") {
      this.graphics.lineStyle(Math.max(2, layout.cellSize * 0.06), 0x7ee58e, 0.65);
      this.graphics.strokeLineShape(new Phaser.Geom.Line(step.tailX, step.tailY, step.fromHeadX, step.fromHeadY));
    }

    const pulseRadius = Math.max(8, layout.cellSize * (0.16 + glowAlpha));
    this.graphics.fillStyle(0x7df0ff, 0.24 + glowAlpha * 0.6);
    this.graphics.fillCircle(interpHeadX, interpHeadY, pulseRadius);
    this.graphics.lineStyle(2, 0xcfffff, 0.85);
    this.graphics.strokeCircle(interpHeadX, interpHeadY, pulseRadius * 0.72);
    this.graphics.restore();

    const logicalStep = this.computeHintLogicalStepInfo(playback, idx);
    if (logicalStep.total > 1 && this.hintStepLabel) {
      this.hintStepLabel.setText(`${logicalStep.current}/${logicalStep.total}`);
      const labelX = Phaser.Math.Clamp(
        interpHeadX + Math.max(14, layout.cellSize * 0.22),
        8,
        this.scale.width - this.hintStepLabel.width - 8
      );
      const labelY = Phaser.Math.Clamp(
        interpHeadY - Math.max(22, layout.cellSize * 0.34),
        8,
        this.scale.height - this.hintStepLabel.height - 8
      );
      this.hintStepLabel.setPosition(labelX, labelY).setVisible(true);
    } else {
      this.hideHintStepLabel();
    }
  }

  private hideHintStepLabel(): void {
    if (this.hintStepLabel) this.hintStepLabel.setVisible(false);
  }

  private computeHintLogicalStepInfo(playback: HintPlayback, index: number): { current: number; total: number } {
    if (!playback.steps.length) return { current: 0, total: 0 };
    const total = this.countHintLogicalSteps(playback.steps);
    let current = 0;
    for (let i = 0; i <= index && i < playback.steps.length; i += 1) {
      if (this.isAutoLaunchStep(playback.steps, i)) continue;
      current += 1;
    }
    return { current: Math.max(1, current), total: Math.max(1, total) };
  }

  private countHintLogicalSteps(steps: HintVisualStep[]): number {
    let count = 0;
    for (let i = 0; i < steps.length; i += 1) {
      if (this.isAutoLaunchStep(steps, i)) continue;
      count += 1;
    }
    return count;
  }

  private isAutoLaunchStep(steps: HintVisualStep[], idx: number): boolean {
    const cur = steps[idx];
    const prev = idx > 0 ? steps[idx - 1] : null;
    if (!cur || !prev) return false;
    if (cur.kind !== "launch" || prev.kind !== "rotate") return false;
    const eps = 0.35;
    const sameTail = Math.abs(cur.tailX - prev.tailX) < eps && Math.abs(cur.tailY - prev.tailY) < eps;
    const launchStartsFromRotateHead =
      Math.abs(cur.fromHeadX - prev.toHeadX) < eps && Math.abs(cur.fromHeadY - prev.toHeadY) < eps;
    return sameTail && launchStartsFromRotateHead;
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
    this.fishes = level.gridFish.map((fish, index) => {
      const tail = getNodePosition(fish[0], fish[1], this.layout!);
      const head = getNodePosition(fish[2], fish[3], this.layout!);
      return {
        id: `f-${this.store.getIndex()}-${index}`,
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
    this.rotationRingCache.clear();
    this.hintStateSpatialCache = new WeakMap<HintFish[], HintStateSpatialIndex>();
    this.rebuildShellSpatialBuckets();
    this.selectedFishIndex = null;
    this.drag = null;
    this.hintPlayback = null;
    this.pendingHintTask = null;
    this.pendingHintRequestKey = null;
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
    this.drawHintOverlay(this.layout);
  }

  private drawNodes(level: LevelData, layout: ReturnType<typeof buildLayout>): void {
    const radius = Math.max(5, layout.cellSize * 0.12);
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

    this.graphics.save();
    this.graphics.translateCanvas(segment.ax, segment.ay);
    this.graphics.rotateCanvas(angle);

    const outline = [
      new Phaser.Math.Vector2(0, 0),
      new Phaser.Math.Vector2(thickness * 0.42, -thickness * 0.76),
      new Phaser.Math.Vector2(thickness * 1.5, -thickness * 0.82),
      new Phaser.Math.Vector2(headStart, -thickness * 0.62),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.26, -thickness * 0.5),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.64, -thickness * 0.28),
      new Phaser.Math.Vector2(headTip, 0),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.64, thickness * 0.28),
      new Phaser.Math.Vector2(bodyEnd + headLength * 0.26, thickness * 0.5),
      new Phaser.Math.Vector2(headStart, thickness * 0.62),
      new Phaser.Math.Vector2(thickness * 1.5, thickness * 0.82),
      new Phaser.Math.Vector2(thickness * 0.42, thickness * 0.76)
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
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    for (const node of candidates) {
      if (!this.canPlaceFish(fishIndex, fish.tailRow, fish.tailCol, node.row, node.col)) continue;
      if (!this.isRotationReachAllowed(fish.fixedLengthPx, tail.x, tail.y, node.x, node.y)) continue;
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
      if (!this.isRotationReachAllowed(fish.fixedLengthPx, tail.x, tail.y, node.x, node.y)) continue;
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

  private findHintPlan(): HintAction[] | null {
    const initial = this.captureHintState();
    if (initial.length === 0) return null;

    const directLaunches = this.generateLaunchActions(initial);
    if (directLaunches.length > 0) {
      const directPlan = [directLaunches[0]];
      if (this.validateHintPlan(initial, directPlan)) return directPlan;
    }

    const maxDepth = Math.min(8, Math.max(4, Math.ceil(initial.length * 0.34) + 2));
    const nodeBudget = 22000;
    const queue: Array<{ state: HintFish[]; plan: HintAction[]; depth: number }> = [
      { state: initial, plan: [], depth: 0 }
    ];
    const visited = new Map<string, number>();
    visited.set(this.serializeHintState(initial), 0);
    let head = 0;
    let expanded = 0;
    let bestFallback: HintAction[] | null = null;

    while (head < queue.length && expanded < nodeBudget) {
      const item = queue[head++];
      expanded += 1;
      if (item.depth >= maxDepth) continue;

      const launches = this.generateLaunchActions(item.state);
      if (launches.length > 0) {
        const candidatePlan = item.plan.concat(launches[0]);
        if (this.validateHintPlan(initial, candidatePlan)) return candidatePlan;
      }

      const rotateActions = this.generateRotateActions(item.state);
      if (!bestFallback && rotateActions.length > 0) bestFallback = item.plan.concat(rotateActions[0]);

      for (const action of rotateActions) {
        const nextState = this.applyHintAction(item.state, action);
        const nextPlan = item.plan.concat(action);
        const key = this.serializeHintState(nextState);
        const prevDepth = visited.get(key);
        if (prevDepth !== undefined && prevDepth <= item.depth + 1) continue;
        visited.set(key, item.depth + 1);
        queue.push({ state: nextState, plan: nextPlan, depth: item.depth + 1 });
      }
    }

    if (bestFallback && this.validateHintPlan(initial, bestFallback)) return bestFallback;
    return null;
  }

  private buildHintVisualSteps(plan: HintAction[]): HintVisualStep[] {
    if (!this.layout) return [];
    const visuals: HintVisualStep[] = [];
    let state = this.captureHintState();
    for (const action of plan) {
      const idx = state.findIndex((fish) => this.hintFishKey(fish) === action.fishKey);
      if (idx < 0) return [];
      const fish = state[idx];
      if (action.kind === "rotate") {
        if (this.checkHintIncrementalSweep(state, idx, action.headRow, action.headCol)) return [];
        if (!this.canPlaceHintFishState(state, idx, action.headRow, action.headCol)) return [];
      } else {
        if (this.launchDistanceForHintState(state, idx) !== Number.POSITIVE_INFINITY) return [];
      }
      const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
      const fromHead = this.hintFishHeadPosition(fish);
      const toHead =
        action.kind === "launch"
          ? this.hintLaunchPreviewHead(fish, Math.max(this.layout.cellSize * 1.75, 54))
          : this.hintHeadPositionForTarget(fish, action.headRow, action.headCol);
      visuals.push({
        kind: action.kind,
        tailX: tail.x,
        tailY: tail.y,
        fromHeadX: fromHead.x,
        fromHeadY: fromHead.y,
        toHeadX: toHead.x,
        toHeadY: toHead.y
      });
      state = this.applyHintAction(state, action);
    }
    return visuals.slice(0, 5);
  }

  private captureHintState(): HintFish[] {
    return this.fishes
      .filter((fish) => fish.state === "idle")
      .map((fish) => ({
        id: fish.id,
        tailRow: fish.tailRow,
        tailCol: fish.tailCol,
        headRow: fish.headRow,
        headCol: fish.headCol,
        fixedLengthPx: fish.fixedLengthPx
      }));
  }

  private generateLaunchActions(state: HintFish[]): HintAction[] {
    const launches: HintAction[] = [];
    for (let i = 0; i < state.length; i += 1) {
      const fish = state[i];
      const key = this.hintFishKey(fish);
      if (this.launchDistanceForHintState(state, i) === Number.POSITIVE_INFINITY) {
        launches.push({
          fishKey: key,
          tailRow: fish.tailRow,
          tailCol: fish.tailCol,
          headRow: fish.headRow,
          headCol: fish.headCol,
          kind: "launch"
        });
      }
    }
    launches.sort((a, b) => a.tailCol - b.tailCol || a.tailRow - b.tailRow);
    return launches;
  }

  private generateRotateActions(state: HintFish[]): HintAction[] {
    const rotates: Array<{ action: HintAction; score: number }> = [];
    for (let i = 0; i < state.length; i += 1) {
      const fish = state[i];
      const key = this.hintFishKey(fish);
      const candidates = this.rotationCandidatesForHintFish(fish);
      const localRotates: Array<{ action: HintAction; score: number }> = [];
      for (const node of candidates) {
        // Skip no-op: rotating to current head node is visually and logically meaningless.
        if (node.row === fish.headRow && node.col === fish.headCol) continue;
        if (this.checkHintIncrementalSweep(state, i, node.row, node.col)) continue;
        if (!this.canPlaceHintFishState(state, i, node.row, node.col)) continue;
        const rotated = this.rotateHintFish(state, i, node.row, node.col);
        const ld = this.launchDistanceForHintState(rotated, i);
        const action: HintAction = {
          fishKey: key,
          tailRow: fish.tailRow,
          tailCol: fish.tailCol,
          headRow: node.row,
          headCol: node.col,
          kind: "rotate"
        };
        const from = this.hintFishHeadPosition(fish);
        const dHead = Phaser.Math.Distance.Between(from.x, from.y, node.x, node.y);
        const launchBoost = ld === Number.POSITIVE_INFINITY ? -2200 : Math.min(1200, ld);
        localRotates.push({ action, score: launchBoost + dHead * 0.35 });
      }
      localRotates.sort((a, b) => a.score - b.score);
      rotates.push(...localRotates.slice(0, 4));
    }
    rotates.sort((a, b) => a.score - b.score);
    return rotates.map((x) => x.action).slice(0, 36);
  }

  private applyHintAction(state: HintFish[], action: HintAction): HintFish[] {
    const next = state.map((fish) => ({ ...fish }));
    const idx = next.findIndex((fish) => this.hintFishKey(fish) === action.fishKey);
    if (idx < 0) return next;
    next[idx].headRow = action.headRow;
    next[idx].headCol = action.headCol;
    if (action.kind === "launch") {
      next.splice(idx, 1);
    }
    return next;
  }

  private serializeHintState(state: HintFish[]): string {
    const parts = state
      .map((fish) =>
        `${fish.id},${fish.tailRow},${fish.tailCol},${fish.headRow},${fish.headCol},${Math.round(fish.fixedLengthPx)}`
      )
      .sort();
    return parts.join("|");
  }

  private hintFishKey(fish: HintFish): string {
    return fish.id;
  }

  private isFirstHintActionExecutable(action: HintAction): boolean {
    if (!this.layout) return false;
    const fishIndex = this.findRuntimeFishIndexForAction(action);
    if (fishIndex < 0) {
      this.pushHintLog(`exec-check fail map action=${this.formatHintAction(action)}`);
      return false;
    }
    const fish = this.fishes[fishIndex];
    if (!fish || fish.state !== "idle") {
      this.pushHintLog(`exec-check fail fish not idle action=${this.formatHintAction(action)}`);
      return false;
    }

    if (action.kind === "launch") {
      const ld = this.launchDistanceForFish(fishIndex);
      const ok = ld === Number.POSITIVE_INFINITY;
      if (!ok) this.pushHintLog(`exec-check launch blocked fish=${fish.id} ld=${Number.isFinite(ld) ? ld.toFixed(2) : "INF"}`);
      return ok;
    }

    const len = this.fishLengthPx(fish);
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const fromAngle = Phaser.Math.Angle.Between(tail.x, tail.y, fish.headX, fish.headY);
    const target = getNodePosition(action.headRow, action.headCol, this.layout);
    if (!this.isRotationReachAllowed(len, tail.x, tail.y, target.x, target.y)) {
      this.pushHintLog(`exec-check rotate reach fail action=${this.formatHintAction(action)}`);
      return false;
    }
    const toAngle = Phaser.Math.Angle.Between(tail.x, tail.y, target.x, target.y);
    if (this.checkIncrementalSweep(fishIndex, fromAngle, toAngle, len)) {
      this.pushHintLog(`exec-check rotate sweep blocked action=${this.formatHintAction(action)}`);
      return false;
    }
    const ok = this.canPlaceFish(fishIndex, fish.tailRow, fish.tailCol, action.headRow, action.headCol);
    if (!ok) this.pushHintLog(`exec-check rotate place fail action=${this.formatHintAction(action)}`);
    return ok;
  }

  private findRuntimeFishIndexForAction(action: HintAction): number {
    // Prefer exact id match.
    let idx = this.fishes.findIndex((fish) => fish.state === "idle" && fish.id === action.fishKey);
    if (idx >= 0) return idx;
    // Prefer exact tail+head match to avoid ambiguity in symmetric layouts.
    idx = this.fishes.findIndex(
      (fish) =>
        fish.state === "idle" &&
        fish.tailRow === action.tailRow &&
        fish.tailCol === action.tailCol &&
        fish.headRow === action.headRow &&
        fish.headCol === action.headCol
    );
    if (idx >= 0) return idx;
    // Do not fallback to tail-only matching: it can map to a wrong fish and
    // produce a "launch hint into blocker" symptom when topology changed.
    this.pushHintLog(`runtime map miss action=${this.formatHintAction(action)}`);
    return -1;
  }

  private findExecutableFallbackAction(): HintAction | null {
    if (!this.layout) return null;
    // 1) Any direct launch that runtime confirms executable.
    for (let i = 0; i < this.fishes.length; i += 1) {
      const fish = this.fishes[i];
      if (fish.state !== "idle") continue;
      if (this.launchDistanceForFish(i) !== Number.POSITIVE_INFINITY) continue;
      return {
        fishKey: fish.id,
        tailRow: fish.tailRow,
        tailCol: fish.tailCol,
        headRow: fish.headRow,
        headCol: fish.headCol,
        kind: "launch"
      };
    }

    // 2) Otherwise pick a legal rotate step.
    for (let i = 0; i < this.fishes.length; i += 1) {
      const fish = this.fishes[i];
      if (fish.state !== "idle") continue;
      const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
      const fromAngle = Phaser.Math.Angle.Between(tail.x, tail.y, fish.headX, fish.headY);
      const len = this.fishLengthPx(fish);
      const candidates = this.rotationCandidatesForFish(fish);
      for (const node of candidates) {
        if (!this.canPlaceFish(i, fish.tailRow, fish.tailCol, node.row, node.col)) continue;
        const toAngle = Phaser.Math.Angle.Between(tail.x, tail.y, node.x, node.y);
        if (this.checkIncrementalSweep(i, fromAngle, toAngle, len)) continue;
        return {
          fishKey: fish.id,
          tailRow: fish.tailRow,
          tailCol: fish.tailCol,
          headRow: node.row,
          headCol: node.col,
          kind: "rotate"
        };
      }
    }
    return null;
  }

  private formatHintAction(action: HintAction): string {
    return `${action.kind}:${action.fishKey} (${action.tailRow},${action.tailCol})->(${action.headRow},${action.headCol})`;
  }

  private formatHintPlan(plan: HintAction[]): string {
    return plan.map((x) => this.formatHintAction(x)).join(" => ");
  }

  private pushHintLog(message: string): void {
    void message;
  }

  private validateHintPlan(initial: HintFish[], plan: HintAction[]): boolean {
    let state = initial.map((fish) => ({ ...fish }));
    for (const action of plan) {
      const idx = state.findIndex((fish) => this.hintFishKey(fish) === action.fishKey);
      if (idx < 0) return false;
      if (action.kind === "rotate") {
        if (this.checkHintIncrementalSweep(state, idx, action.headRow, action.headCol)) return false;
        if (!this.canPlaceHintFishState(state, idx, action.headRow, action.headCol)) return false;
      } else {
        if (this.launchDistanceForHintState(state, idx) !== Number.POSITIVE_INFINITY) return false;
      }
      state = this.applyHintAction(state, action);
    }
    return true;
  }

  private rotateHintFish(state: HintFish[], fishIndex: number, headRow: number, headCol: number): HintFish[] {
    const out = state.map((fish) => ({ ...fish }));
    out[fishIndex].headRow = headRow;
    out[fishIndex].headCol = headCol;
    return out;
  }

  private hintFishHeadPosition(fish: HintFish): { x: number; y: number } {
    if (!this.layout) return { x: 0, y: 0 };
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const target = getNodePosition(fish.headRow, fish.headCol, this.layout);
    const angle = Phaser.Math.Angle.Between(tail.x, tail.y, target.x, target.y);
    return {
      x: tail.x + Math.cos(angle) * fish.fixedLengthPx,
      y: tail.y + Math.sin(angle) * fish.fixedLengthPx
    };
  }

  private hintHeadPositionForTarget(fish: HintFish, headRow: number, headCol: number): { x: number; y: number } {
    if (!this.layout) return { x: 0, y: 0 };
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const target = getNodePosition(headRow, headCol, this.layout);
    const angle = Phaser.Math.Angle.Between(tail.x, tail.y, target.x, target.y);
    return {
      x: tail.x + Math.cos(angle) * fish.fixedLengthPx,
      y: tail.y + Math.sin(angle) * fish.fixedLengthPx
    };
  }

  private hintLaunchPreviewHead(fish: HintFish, extra: number): { x: number; y: number } {
    const head = this.hintFishHeadPosition(fish);
    if (!this.layout) return head;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const dirX = head.x - tail.x;
    const dirY = head.y - tail.y;
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-6) return head;
    return {
      x: head.x + (dirX / len) * extra,
      y: head.y + (dirY / len) * extra
    };
  }

  private segmentForHintFish(fish: HintFish): Segment {
    if (!this.layout) return { ax: 0, ay: 0, bx: 0, by: 0 };
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const head = this.hintFishHeadPosition(fish);
    return { ax: tail.x, ay: tail.y, bx: head.x, by: head.y };
  }

  private launchDistanceForHintState(state: HintFish[], fishIndex: number): number {
    const fish = state[fishIndex];
    if (!fish) return Number.POSITIVE_INFINITY;
    const seg = this.segmentForHintFish(fish);
    const dirX = seg.bx - seg.ax;
    const dirY = seg.by - seg.ay;
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-6) return Number.POSITIVE_INFINITY;
    const nx = dirX / len;
    const ny = dirY / len;
    return this.firstBlockDistanceForHintState(state, fishIndex, seg.bx + nx, seg.by + ny, nx, ny);
  }

  private firstBlockDistanceForHintState(
    state: HintFish[],
    fishIndex: number,
    ax: number,
    ay: number,
    dx: number,
    dy: number
  ): number {
    if (!this.layout) return Number.POSITIVE_INFINITY;
    const far = 4000;
    const bx = ax + dx * far;
    const by = ay + dy * far;
    const epsilon = 1e-3;
    const fishRadius = this.layout.cellSize * 0.23;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < state.length; i += 1) {
      if (i === fishIndex) continue;
      const seg = this.segmentForHintFish(state[i]);
      const hit = this.raySegmentIntersection(ax, ay, bx, by, seg.ax, seg.ay, seg.bx, seg.by);
      if (hit !== null && hit > epsilon && hit < best) best = hit;
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

  private canPlaceHintFishState(state: HintFish[], fishIndex: number, headRow: number, headCol: number): boolean {
    if (!this.layout) return false;
    const fish = state[fishIndex];
    if (!fish) return false;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const target = getNodePosition(headRow, headCol, this.layout);
    const angle = Phaser.Math.Angle.Between(tail.x, tail.y, target.x, target.y);
    const headX = tail.x + Math.cos(angle) * fish.fixedLengthPx;
    const headY = tail.y + Math.sin(angle) * fish.fixedLengthPx;
    const seg: Segment = { ax: tail.x, ay: tail.y, bx: headX, by: headY };
    const thickness = this.layout.cellSize * 0.23;
    const index = this.getHintStateSpatialIndex(state);
    const nearbyFish = this.queryFishBucketIndexes(index, seg.ax, seg.ay, seg.bx, seg.by, thickness);

    for (let i = 0; i < state.length; i += 1) {
      if (i === fishIndex) continue;
      const other = state[i];
      // Endpoints are exclusive: different fish cannot share any node endpoint.
      if (
        (other.tailRow === fish.tailRow && other.tailCol === fish.tailCol) ||
        (other.tailRow === headRow && other.tailCol === headCol) ||
        (other.headRow === fish.tailRow && other.headCol === fish.tailCol) ||
        (other.headRow === headRow && other.headCol === headCol)
      ) {
        return false;
      }
    }
    for (const i of nearbyFish) {
      if (i === fishIndex) continue;
      const otherSeg = index.fishSegments[i];
      const d = this.segmentDistance(seg.ax, seg.ay, seg.bx, seg.by, otherSeg.ax, otherSeg.ay, otherSeg.bx, otherSeg.by);
      if (d < thickness) return false;
    }
    const shellRadius = this.layout.cellSize * 0.24;
    for (const p of this.queryShellBucketPoints(seg.ax, seg.ay, seg.bx, seg.by, shellRadius)) {
      if (this.distancePointToSegment(p.x, p.y, seg.ax, seg.ay, seg.bx, seg.by) < shellRadius) return false;
    }
    return true;
  }

  private checkHintIncrementalSweep(
    state: HintFish[],
    fishIndex: number,
    headRow: number,
    headCol: number
  ): boolean {
    if (!this.layout) return true;
    const fish = state[fishIndex];
    if (!fish) return true;
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    const fromHead = this.hintFishHeadPosition(fish);
    const toTarget = getNodePosition(headRow, headCol, this.layout);
    const fromAngle = Phaser.Math.Angle.Between(tail.x, tail.y, fromHead.x, fromHead.y);
    const toAngle = Phaser.Math.Angle.Between(tail.x, tail.y, toTarget.x, toTarget.y);
    const diff = Phaser.Math.Angle.Wrap(toAngle - fromAngle);
    const absDiff = Math.abs(diff);
    const steps = Math.max(8, Math.min(72, Math.ceil(absDiff / (Math.PI / 48))));
    for (let s = 1; s <= steps; s += 1) {
      const a = fromAngle + (diff * s) / steps;
      const hx = tail.x + Math.cos(a) * fish.fixedLengthPx;
      const hy = tail.y + Math.sin(a) * fish.fixedLengthPx;
      if (this.checkHintStaticCollisionSegment(state, fishIndex, tail.x, tail.y, hx, hy)) return true;
    }
    return false;
  }

  private checkHintStaticCollisionSegment(
    state: HintFish[],
    ignoreFishIndex: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): boolean {
    if (!this.layout) return true;
    const index = this.getHintStateSpatialIndex(state);
    const fishRadius = this.layout.cellSize * 0.23;
    const shellRadius = this.layout.cellSize * 0.24;
    const nearbyFish = this.queryFishBucketIndexes(index, ax, ay, bx, by, fishRadius);
    for (const i of nearbyFish) {
      if (i === ignoreFishIndex) continue;
      const seg = index.fishSegments[i];
      if (this.lineSegmentsIntersect(ax, ay, bx, by, seg.ax, seg.ay, seg.bx, seg.by)) return true;
      if (this.distancePointToSegment(seg.ax, seg.ay, ax, ay, bx, by) < fishRadius) return true;
      if (this.distancePointToSegment(seg.bx, seg.by, ax, ay, bx, by) < fishRadius) return true;
      if (this.distancePointToSegment(ax, ay, seg.ax, seg.ay, seg.bx, seg.by) < fishRadius) return true;
      if (this.distancePointToSegment(bx, by, seg.ax, seg.ay, seg.bx, seg.by) < fishRadius) return true;
    }
    for (const p of this.queryShellBucketPoints(ax, ay, bx, by, shellRadius)) {
      if (this.distancePointToSegment(p.x, p.y, ax, ay, bx, by) < shellRadius) return true;
    }
    return false;
  }

  private rotationCandidatesForHintFish(fish: HintFish): NodeRef[] {
    if (!this.layout || !this.currentLevel) return [];
    const lenUnits = Math.max(1, Math.round(fish.fixedLengthPx / this.layout.cellSize));
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    return this.getRotationRingCandidates(fish.tailRow, fish.tailCol, lenUnits).filter((node) =>
      this.isRotationReachAllowed(fish.fixedLengthPx, tail.x, tail.y, node.x, node.y)
    );
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
    const lenUnits = Math.max(1, Math.round(fish.fixedLengthPx / this.layout.cellSize));
    const tail = getNodePosition(fish.tailRow, fish.tailCol, this.layout);
    return this.getRotationRingCandidates(fish.tailRow, fish.tailCol, lenUnits).filter((node) =>
      this.isRotationReachAllowed(fish.fixedLengthPx, tail.x, tail.y, node.x, node.y)
    );
  }

  private isRotationReachAllowed(lengthPx: number, tailX: number, tailY: number, headX: number, headY: number): boolean {
    if (!this.layout) return true;
    const isLongFish = Math.round(lengthPx / this.layout.cellSize) >= 4;
    if (!isLongFish) return true;
    const longFishMinReach = lengthPx - this.layout.cellSize * 0.1;
    const reach = Phaser.Math.Distance.Between(tailX, tailY, headX, headY);
    return reach + 1e-3 >= longFishMinReach;
  }

  private getRotationRingCandidates(tailRow: number, tailCol: number, lenUnits: number): NodeRef[] {
    if (!this.layout || !this.currentLevel) return [];
    const cacheKey = `${tailRow},${tailCol},${lenUnits}`;
    const cached = this.rotationRingCache.get(cacheKey);
    if (cached) return cached;
    const tail = getNodePosition(tailRow, tailCol, this.layout);
    const out: NodeRef[] = [];
    for (let col = 0; col < this.currentLevel.cols; col += 1) {
      const rowCount = this.rowCountForCol(this.currentLevel.rows, col);
      for (let row = 0; row < rowCount; row += 1) {
        if (row === tailRow && col === tailCol) continue;
        const node = getNodePosition(row, col, this.layout);
        const lenUnitsToNode = Math.round(
          Phaser.Math.Distance.Between(tail.x, tail.y, node.x, node.y) / this.layout.cellSize
        );
        if (lenUnitsToNode === lenUnits) out.push({ row, col, x: node.x, y: node.y });
      }
    }
    this.rotationRingCache.set(cacheKey, out);
    return out;
  }

  private rebuildShellSpatialBuckets(): void {
    this.shellSpatialBuckets.clear();
    if (!this.layout) return;
    const cell = Math.max(12, this.layout.cellSize * 0.9);
    this.shellSpatialCell = cell;
    for (const shell of this.shells) {
      const p = getNodePosition(shell.row, shell.col, this.layout);
      const key = this.bucketKey(Math.floor(p.x / cell), Math.floor(p.y / cell));
      const list = this.shellSpatialBuckets.get(key);
      if (list) list.push({ row: shell.row, col: shell.col, x: p.x, y: p.y });
      else this.shellSpatialBuckets.set(key, [{ row: shell.row, col: shell.col, x: p.x, y: p.y }]);
    }
  }

  private getHintStateSpatialIndex(state: HintFish[]): HintStateSpatialIndex {
    const cached = this.hintStateSpatialCache.get(state);
    if (cached) return cached;
    const layout = this.layout;
    if (!layout) {
      return { fishSegments: [], fishBuckets: new Map<string, number[]>(), bucketCell: 16 };
    }
    const bucketCell = Math.max(12, layout.cellSize * 0.9);
    const fishRadius = layout.cellSize * 0.23;
    const fishSegments = state.map((fish) => this.segmentForHintFish(fish));
    const fishBuckets = new Map<string, number[]>();
    for (let i = 0; i < fishSegments.length; i += 1) {
      this.insertSegmentIntoBuckets(fishBuckets, fishSegments[i], i, bucketCell, fishRadius);
    }
    const index = { fishSegments, fishBuckets, bucketCell };
    this.hintStateSpatialCache.set(state, index);
    return index;
  }

  private insertSegmentIntoBuckets(
    buckets: Map<string, number[]>,
    seg: Segment,
    idx: number,
    cell: number,
    pad: number
  ): void {
    const minX = Math.min(seg.ax, seg.bx) - pad;
    const maxX = Math.max(seg.ax, seg.bx) + pad;
    const minY = Math.min(seg.ay, seg.by) - pad;
    const maxY = Math.max(seg.ay, seg.by) + pad;
    const minCx = Math.floor(minX / cell);
    const maxCx = Math.floor(maxX / cell);
    const minCy = Math.floor(minY / cell);
    const maxCy = Math.floor(maxY / cell);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = this.bucketKey(cx, cy);
        const list = buckets.get(key);
        if (list) list.push(idx);
        else buckets.set(key, [idx]);
      }
    }
  }

  private queryFishBucketIndexes(
    index: HintStateSpatialIndex,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    pad: number
  ): number[] {
    const minX = Math.min(ax, bx) - pad;
    const maxX = Math.max(ax, bx) + pad;
    const minY = Math.min(ay, by) - pad;
    const maxY = Math.max(ay, by) + pad;
    const minCx = Math.floor(minX / index.bucketCell);
    const maxCx = Math.floor(maxX / index.bucketCell);
    const minCy = Math.floor(minY / index.bucketCell);
    const maxCy = Math.floor(maxY / index.bucketCell);
    const out = new Set<number>();
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const list = index.fishBuckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (const idx of list) out.add(idx);
      }
    }
    return Array.from(out.values());
  }

  private queryShellBucketPoints(ax: number, ay: number, bx: number, by: number, pad: number): NodeRef[] {
    if (!this.shellSpatialCell) return [];
    const minX = Math.min(ax, bx) - pad;
    const maxX = Math.max(ax, bx) + pad;
    const minY = Math.min(ay, by) - pad;
    const maxY = Math.max(ay, by) + pad;
    const minCx = Math.floor(minX / this.shellSpatialCell);
    const maxCx = Math.floor(maxX / this.shellSpatialCell);
    const minCy = Math.floor(minY / this.shellSpatialCell);
    const maxCy = Math.floor(maxY / this.shellSpatialCell);
    const out = new Map<string, NodeRef>();
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const list = this.shellSpatialBuckets.get(this.bucketKey(cx, cy));
        if (!list) continue;
        for (const p of list) {
          out.set(`${p.row},${p.col}`, p);
        }
      }
    }
    return Array.from(out.values());
  }

  private bucketKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
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
