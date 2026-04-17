import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";

const parent = document.getElementById("game-root");

if (!parent) {
  throw new Error("Missing #game-root");
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent,
  backgroundColor: "#def7ff",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: parent.clientWidth,
    height: parent.clientHeight
  },
  scene: [BootScene, GameScene],
  render: {
    antialias: true,
    roundPixels: false
  }
});
