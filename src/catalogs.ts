import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { catalog, type Catalog } from "./models.js";
import type { Config } from "./config.js";
import { readPrivate, writePrivate } from "./storage.js";

export async function readJsonFile(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 2_000_000) throw new Error("Input must be a regular JSON file smaller than 2 MB");
  const text = await readFile(path, "utf8");
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("Input is not valid strict JSON; file contents withheld"); }
}
export async function importCatalog(config: Config, path: string): Promise<number> {
  const entries = catalog.parse(await readJsonFile(path));
  await writePrivate(config.dataDir, "catalog.json", entries);
  return entries.length;
}
export async function localCatalog(config: Config): Promise<{ source: string; entries: Catalog }> {
  const value = await readPrivate(join(config.dataDir, "catalog.json"));
  if (value === undefined) return { source: "not-imported", entries: [] };
  return { source: "user-imported-static-catalog-not-live-pricing", entries: catalog.parse(value) };
}
