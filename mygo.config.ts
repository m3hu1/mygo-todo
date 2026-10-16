import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "Todo",
  identifier: "dev.mehul.todo",
  version: "1.0.0",
  // The app's Go package and the frontend `mygo dev`/`mygo build` run and
  // embed.
  main: "./cmd/todo",
  devUrl: "http://localhost:5173",
  devCommand: "bun run --cwd frontend dev",
  buildCommand: "bun run --cwd frontend build",
  frontendDist: "frontend/dist",
  bindings: "frontend/src/mygo.ts",
  out: "build",
  macos: {
    // A menu bar app: no Dock icon and no app switcher entry.
    infoPlist: { LSUIElement: true },
  },
});
