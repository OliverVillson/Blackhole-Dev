// The user's workspace folder: recipes/, functions/, models/. File access from the renderer is
// confined to it.

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile, readdir, stat, rename, rm, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";
import type { AppPaths } from "../shared/ext";
import { STARTER } from "../shared/starter";

export function workspacePaths(root: string, userData: string): AppPaths {
  return {
    userData,
    workspace: root,
    recipes: join(root, "recipes"),
    functions: join(root, "functions"),
    models: join(root, "models"),
  };
}

export function ensureWorkspace(p: AppPaths): void {
  const fresh = !existsSync(p.recipes);
  for (const d of [p.workspace, p.recipes, p.functions, p.models]) mkdirSync(d, { recursive: true });
  if (fresh) writeFileSync(join(p.recipes, "first-recipe.py"), STARTER.recipe("first-recipe"));
}

export interface Entry {
  path: string;
  name: string;
  dir: boolean;
  children?: Entry[];
}

export class Workspace {
  constructor(public paths: AppPaths) {}

  /** Resolve a path given by the renderer and refuse anything outside the workspace. */
  inside(p: string): string {
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.paths.workspace, p);
    const rel = relative(this.paths.workspace, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`outside the workspace: ${p}`);
    return abs;
  }

  async read(p: string): Promise<string> {
    return readFile(this.inside(p), "utf8");
  }

  async write(p: string, text: string): Promise<void> {
    const abs = this.inside(p);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = abs + ".bh-tmp";
    await writeFile(tmp, text);
    await rename(tmp, abs);
  }

  async create(dir: string, name: string, text: string): Promise<string> {
    const clean = basename(name).replace(/[^A-Za-z0-9._-]/g, "-");
    let abs = this.inside(join(dir, clean.endsWith(".py") ? clean : clean + ".py"));
    for (let i = 2; existsSync(abs); i++) abs = abs.replace(/(-\d+)?\.py$/, `-${i}.py`);
    await this.write(abs, text);
    return abs;
  }

  async rename(from: string, toName: string): Promise<string> {
    const src = this.inside(from);
    const dst = this.inside(join(dirname(src), basename(toName)));
    if (existsSync(dst)) throw new Error(`${basename(dst)} already exists`);
    await rename(src, dst);
    return dst;
  }

  async remove(p: string, trash?: (abs: string) => Promise<void>): Promise<void> {
    const abs = this.inside(p);
    if (trash) await trash(abs);
    else await rm(abs);
  }

  async list(dir: string, exts = [".py"]): Promise<Entry[]> {
    const abs = this.inside(dir);
    if (!existsSync(abs)) return [];
    const out: Entry[] = [];
    for (const name of (await readdir(abs)).sort()) {
      if (name.startsWith(".") || name === "__pycache__") continue;
      const full = join(abs, name);
      const s = await stat(full);
      if (s.isDirectory()) out.push({ path: full, name, dir: true, children: await this.list(full, exts) });
      else if (exts.some((e) => name.endsWith(e))) out.push({ path: full, name, dir: false });
    }
    return out;
  }
}
