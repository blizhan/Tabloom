import fs from "node:fs";
import path from "node:path";

export const runtimeAssetHeaders = {
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
};

export function copyDirectory(source: string, destination: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

export function copyFiles(sourceRoot: string, destinationRoot: string, files: readonly string[]): void {
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const file of files) {
    const from = path.join(sourceRoot, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destinationRoot, file));
  }
}
