// src/lib/data.ts
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against the site package itself so workspace/root shell cwd does not matter.
const GENERATED_PUBLIC_ROOT = fileURLToPath(new URL("../../public/generated/", import.meta.url));

export async function readPublicJson<T>(publicRelativePath: string): Promise<T> {
    const rel = publicRelativePath.replaceAll("\\", "/").replace(/^\/+/, "");
    const filePath = path.resolve(GENERATED_PUBLIC_ROOT, rel);
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
}

export function buildIndex<T extends { id: string }>(arr: T[]) {
    return new Map(arr.map((x) => [String(x.id), x]));
}

export function resolveLootIdForUnit(unit: any, lootById: Map<string, any>): string | null {
    const candidates = [
        unit?.type && String(unit.type),
        unit?.id && String(unit.id),
        unit?.id && String(unit.id).split("_")[0],
    ].filter(Boolean) as string[];

    for (const c of candidates) if (lootById.has(c)) return c;
    return null;
}

export function extractBracketRefs(text: string | undefined | null): string[] {
    if (!text) return [];
    const out: string[] = [];
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
}

export function unitItemRefs(unit: any): string[] {
    const refs: string[] = [];
    const gear = unit?.parts?.gear ?? [];
    const weapons = unit?.parts?.weapons ?? [];
    const defense = unit?.parts?.defense;

    for (const g of gear) if (g?.ref) refs.push(String(g.ref));
    for (const w of weapons) if (w?.ref) refs.push(String(w.ref));
    if (defense) refs.push(String(defense));

    return refs;
}
