import os from "node:os";
import path from "node:path";

export const stateDir = path.join(os.homedir(), ".muse-tab");
export const chromeDir = path.join(stateDir, "chrome");
export const debugPort = 9341;
