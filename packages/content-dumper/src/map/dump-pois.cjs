const fs = require("fs");
const path = require("path");

const MAP_TILE_CHUNKS_PER_SIDE = 3;
const DEFAULT_GAMEPLAY_CELLS_PER_FILE_POW = 5;
const TERRAIN_WORLD_UNIT = 3;

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, {recursive: true});
}

function floorDiv(a, b) {
    return Math.floor(a / b);
}

function findNodes(root, predicate, out = []) {
    if (!root || typeof root !== "object") return out;
    if (predicate(root)) out.push(root);
    if (Array.isArray(root.children)) {
        for (const c of root.children) findNodes(c, predicate, out);
    }
    return out;
}

function parseChunkFromPath(p) {
    const parts = p.split(/[\\/]/);
    for (const seg of parts) {
        const m = seg.match(/^L(\d+)_([+-]?\d+)_([+-]?\d+)$/);
        if (m) {
            return {
                level: parseInt(m[1], 10),
                I: parseInt(m[2], 10),
                J: parseInt(m[3], 10),
                id: seg,
            };
        }
    }
    return null;
}

function parseMinimapTileName(file) {
    const m = file.match(/^(-?\d+)_(-?\d+)_(\d+)\.png$/i);
    if (!m) return null;
    return {
        tileX: parseInt(m[1], 10),
        tileY: parseInt(m[2], 10),
        tileRes: parseInt(m[3], 10),
    };
}

function loadWorldParams(worldPrefabPath) {
    const world = readJson(worldPrefabPath);

    const terrainNodes = findNodes(
        world,
        n => n && typeof n === "object" && n.type === "gterrain"
    );
    if (!terrainNodes.length) {
        throw new Error("Could not find gterrain node in world prefab.");
    }

    const gameplayNodes = findNodes(
        world,
        n => n && typeof n === "object" && n.type === "world" && n.name === "gameplayData"
    );
    if (!gameplayNodes.length) {
        throw new Error("Could not find gameplayData world node in world prefab.");
    }

    const terrain = terrainNodes[0];
    const gameplay = gameplayNodes[0];

    const terrainCellsPerFilePow = terrain.cellsPerFilePow;
    if (typeof terrainCellsPerFilePow !== "number") {
        throw new Error("terrain.cellsPerFilePow missing in world prefab.");
    }

    const gameplayWorldUnit =
        typeof gameplay.worldUnit === "number" ? gameplay.worldUnit : 1;

    const gameplayCellsPerFilePow =
        typeof gameplay.cellsPerFilePow === "number"
            ? gameplay.cellsPerFilePow
            : DEFAULT_GAMEPLAY_CELLS_PER_FILE_POW;

    const gameplayBaseChunkSize =
        (1 << gameplayCellsPerFilePow) * gameplayWorldUnit;

    const terrainChunkWidth =
        (1 << terrainCellsPerFilePow) * TERRAIN_WORLD_UNIT;

    const tileWorld = terrainChunkWidth * MAP_TILE_CHUNKS_PER_SIDE;

    const loadedChunkIds = new Set(
        Array.isArray(gameplay.chunkData)
            ? gameplay.chunkData.map(x => x.id)
            : []
    );

    return {
        gameplayBaseChunkSize,
        gameplayCellsPerFilePow,
        gameplayWorldUnit,
        terrainCellsPerFilePow,
        terrainChunkWidth,
        tileWorld,
        loadedChunkIds,
    };
}

function loadMinimapMeta(minimapDir, tileWorld) {
    const files = fs.readdirSync(minimapDir);
    const tiles = files
        .map(parseMinimapTileName)
        .filter(Boolean);

    if (!tiles.length) {
        throw new Error(`No minimap tiles found in ${minimapDir}`);
    }

    const tileResSet = [...new Set(tiles.map(t => t.tileRes))];
    if (tileResSet.length !== 1) {
        throw new Error(`Expected one minimap tile resolution, got ${tileResSet.join(", ")}`);
    }

    const tilePx = tileResSet[0];

    let minTX = Infinity;
    let maxTX = -Infinity;
    let minTY = Infinity;
    let maxTY = -Infinity;

    for (const t of tiles) {
        minTX = Math.min(minTX, t.tileX);
        maxTX = Math.max(maxTX, t.tileX);
        minTY = Math.min(minTY, t.tileY);
        maxTY = Math.max(maxTY, t.tileY);
    }

    return {
        tileWorld,
        tilePx,
        pxPerWorld: tilePx / tileWorld,
        minTX,
        maxTX,
        minTY,
        maxTY,
        width: (maxTX - minTX + 1) * tilePx,
        height: (maxTY - minTY + 1) * tilePx,
    };
}

function worldToPixel(worldX, worldY, meta) {
    const {tileWorld, tilePx, pxPerWorld, minTX, minTY} = meta;

    const tileX = floorDiv(worldX, tileWorld);
    const tileY = floorDiv(worldY, tileWorld);

    const localX = worldX - tileX * tileWorld;
    const localY = worldY - tileY * tileWorld;

    const px = (tileX - minTX) * tilePx + localX * pxPerWorld;
    const py = (tileY - minTY) * tilePx + localY * pxPerWorld;

    return {tileX, tileY, px, py};
}

// 2D affine transform:
// [ a c tx ]
// [ b d ty ]
function identityT() {
    return {a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0};
}

function mulT(p, l) {
    return {
        a: p.a * l.a + p.c * l.b,
        b: p.b * l.a + p.d * l.b,
        c: p.a * l.c + p.c * l.d,
        d: p.b * l.c + p.d * l.d,
        tx: p.a * l.tx + p.c * l.ty + p.tx,
        ty: p.b * l.tx + p.d * l.ty + p.ty,
    };
}

function applyT(t, x, y) {
    return {
        x: t.a * x + t.c * y + t.tx,
        y: t.b * x + t.d * y + t.ty,
    };
}

function nodeLocalT(node) {
    const x = typeof node.x === "number" ? node.x : 0;
    const y = typeof node.y === "number" ? node.y : 0;

    const sx =
        typeof node.scaleX === "number"
            ? node.scaleX
            : typeof node.scale === "number"
                ? node.scale
                : 1;

    const sy =
        typeof node.scaleY === "number"
            ? node.scaleY
            : typeof node.scale === "number"
                ? node.scale
                : 1;

    let rz = typeof node.rotationZ === "number" ? node.rotationZ : 0;
    if (Math.abs(rz) > 6.283185307179586) {
        rz = (rz * Math.PI) / 180.0;
    }

    const cos = Math.cos(rz);
    const sin = Math.sin(rz);

    return {
        a: cos * sx,
        b: sin * sx,
        c: -sin * sy,
        d: cos * sy,
        tx: x,
        ty: y,
    };
}

function traversePrefab(node, parentT, visit) {
    if (!node || typeof node !== "object") return;

    const absT = mulT(parentT, nodeLocalT(node));
    visit(node, absT);

    if (Array.isArray(node.children)) {
        for (const c of node.children) {
            traversePrefab(c, absT, visit);
        }
    }
}

function loadCdbLookups(cdbPath) {
    const data = readJson(cdbPath);

    const unitSheet = data.sheets.find(({name}) => name === "unit");
    const unitGroupSheet = data.sheets.find(({name}) => name === "unitGroup");

    if (!unitSheet) {
        throw new Error(`Could not find unit sheet in ${cdbPath}`);
    }

    const unitsById = new Map();
    for (const row of unitSheet.lines) {
        unitsById.set(row.id, row);
    }

    const unitGroupsById = new Map();
    if (unitGroupSheet) {
        for (const row of unitGroupSheet.lines) {
            unitGroupsById.set(row.id, row);
        }
    }

    return {unitsById, unitGroupsById};
}

function unitLabel(unitId, unitsById) {
    if (!unitId) return null;
    const row = unitsById.get(unitId);
    return row?.texts?.name || unitId;
}

function unitIcon(unitId, unitsById) {
    if (!unitId) return null;
    const row = unitsById.get(unitId);
    return row?.gfx?.file ? `/icons/${row.gfx.file}` : null;
}

function firstUnitFromGroup(unitGroupId, unitGroupsById) {
    if (!unitGroupId) return null;
    const row = unitGroupsById.get(unitGroupId);
    if (!row?.composition) return null;

    for (const comp of row.composition) {
        if (!Array.isArray(comp.group)) continue;
        for (const member of comp.group) {
            if (member?.unit) return member.unit;
        }
    }

    return null;
}

function iconForSpawn(unitId, unitGroupId, unitsById, unitGroupsById) {
    const direct = unitIcon(unitId, unitsById);
    if (direct) return direct;

    const fallbackUnitId = firstUnitFromGroup(unitGroupId, unitGroupsById);
    return unitIcon(fallbackUnitId, unitsById);
}

function unitGroupPreview(unitGroupId, unitGroupsById, unitsById) {
    if (!unitGroupId) return null;
    const row = unitGroupsById.get(unitGroupId);
    if (!row) return unitGroupId;

    const names = [];
    for (const comp of row.composition || []) {
        for (const member of comp.group || []) {
            if (!member.unit) continue;
            const label = unitLabel(member.unit, unitsById) || member.unit;
            if (!names.includes(label)) names.push(label);
        }
    }

    if (!names.length) return unitGroupId;
    return `${unitGroupId} (${names.slice(0, 3).join(" / ")})`;
}

function humanize(value) {
    if (!value) return null;
    return String(value)
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
}

function gatherableLabelFromName(name) {
    if (!name) return null;
    const label = humanize(name);
    return label
        .replace(/\bSmall\b/i, "(Small)")
        .replace(/\bLarge\b/i, "(Large)");
}

function merchantTrainerLabel(node) {
    const name = node.name || node.props?.id || "Merchant / Trainer";
    return humanize(name);
}

function npcLabel(node, cdb) {
    const npc = node.props?.props?.npc || {};
    if (node.name && node.name !== "Generic") return humanize(node.name);
    if (node.props?.id) return humanize(node.props.id);
    return unitLabel(npc.unit, cdb.unitsById) || "NPC";
}

function activityLabel(node) {
    return (
        node.props?.texts?.name ||
        humanize(node.name) ||
        node.props?.id ||
        "Activity"
    );
}

function chestLabel(node) {
    if (node.name === "WorldChest") return "World Chest";
    if (node.name === "Chest") return "Chest";
    return humanize(node.name || node.props?.id || "Chest");
}

function listGameplayPrefabs(rootDir) {
    const out = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name === "gameplayData.prefab") out.push(full);
        }
    }
    walk(rootDir);
    return out;
}

function mapNodeToPixel(rec, minimapMeta, gameplayBaseChunkSize) {
    const chunkSize = gameplayBaseChunkSize * (1 << rec.level);

    const worldX = (rec.I - 0.5) * chunkSize + rec.localAbsX;
    const worldY = (rec.J - 0.5) * chunkSize + rec.localAbsY;

    const p = worldToPixel(worldX, worldY, minimapMeta);

    return {
        chunkSize,
        worldX,
        worldY,
        minimapTileX: p.tileX,
        minimapTileY: p.tileY,
        px: p.px,
        py: p.py,
    };
}

function hasNpcProps(node) {
    return !!node?.props?.props?.npc;
}

function isMerchantTrainerElement(node) {
    const name = node?.name || "";
    const id = node?.props?.id || "";
    const pprops = node?.props?.props || {};
    const source = node?.source || "";

    return !!pprops.shop ||
        /merchant|trainer|tamer/i.test(name) ||
        /merchant|trainer|tamer/i.test(id) ||
        /merchant|trainer|tamer/i.test(source);
}

function isRespawnElement(node) {
    const name = node?.name || "";
    const id = node?.props?.id || "";
    return /respawn(point|zone)?/i.test(name) || /respawn(point|zone)?/i.test(id);
}

function isChestElement(node) {
    const name = node?.name || "";
    return /chest/i.test(name);
}

function isOreElement(node) {
    const source = node?.source || "";
    const name = node?.name || "";
    return /Gameplay\/Prefabs\/Gatherables\/Ores\//i.test(source) ||
        /ore|tungstene/i.test(name);
}

function isGatherableElement(node) {
    const source = node?.source || "";
    const name = node?.name || "";
    return /Gameplay\/Prefabs\/Gatherables\/Plants\//i.test(source) ||
        /madrigold|lavendula|thyme|zealotus/i.test(name);
}

function isTraversalElement(node) {
    const name = node?.name || "";
    const id = node?.props?.id || "";
    return /geyser|bumper|flypathspline|obelisk|kobold_kart|kobold_cart|instanceorb|magicorb|startorb|orb/i.test(name) ||
        /^Patrol_/i.test(id);
}

function extractWorldNodes(worldRootDir, loadedChunkIds) {
    const gameplayFiles = listGameplayPrefabs(worldRootDir);
    const records = [];

    for (const fp of gameplayFiles) {
        const chunk = parseChunkFromPath(fp);
        if (!chunk) continue;
        if (!loadedChunkIds.has(chunk.id)) continue;

        let json;
        try {
            json = readJson(fp);
        } catch {
            continue;
        }

        const roots = Array.isArray(json.children) ? json.children : [];

        for (const child of roots) {
            traversePrefab(child, identityT(), (node, absT) => {
                const props = node.props || {};
                const cdbtype = props.$cdbtype;
                if (!cdbtype) return;

                const pos = applyT(absT, 0, 0);

                records.push({
                    file: fp,
                    chunkId: chunk.id,
                    level: chunk.level,
                    I: chunk.I,
                    J: chunk.J,
                    localAbsX: pos.x,
                    localAbsY: pos.y,
                    node,
                    cdbtype,
                });
            });
        }
    }

    return records;
}

function baseRow(rec, mapped, type, label, icon = null) {
    return {
        id: `${type}-${rec.chunkId}-${rec.node?.props?.id || rec.node?.name || "node"}`,
        type,
        label,
        icon,
        px: mapped.px,
        py: mapped.py,
        worldX: mapped.worldX,
        worldY: mapped.worldY,
        chunkId: rec.chunkId,
        file: rec.file,
    };
}

function buildOutputs(records, minimapMeta, worldParams, cdb) {
    const outputs = {
        mobs: [],
        npcs: [],
        ores: [],
        gatherables: [],
        chests: [],
        activities: [],
        merchants_trainers: [],
        respawn_points: [],
        traversal_pois: [],
    };

    for (const rec of records) {
        const mapped = mapNodeToPixel(rec, minimapMeta, worldParams.gameplayBaseChunkSize);
        if (!Number.isFinite(mapped.px) || !Number.isFinite(mapped.py)) continue;

        const node = rec.node;
        const props = node.props || {};
        const pprops = props.props || {};

        if (rec.cdbtype === "spawner") {
            const unitId = props.unit ?? null;
            const unitGroup = props.unitGroup ?? null;
            if (!unitId && !unitGroup) continue;

            const label =
                unitLabel(unitId, cdb.unitsById) ||
                unitGroupPreview(unitGroup, cdb.unitGroupsById, cdb.unitsById) ||
                unitId ||
                unitGroup ||
                "Mob";

            const icon = iconForSpawn(
                unitId,
                unitGroup,
                cdb.unitsById,
                cdb.unitGroupsById
            );

            outputs.mobs.push({
                ...baseRow(rec, mapped, "mob", label, icon),
                unitId,
                unitGroup,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (rec.cdbtype === "activity") {
            outputs.activities.push({
                ...baseRow(rec, mapped, "activity", activityLabel(node), null),
                activityId: props.id ?? null,
                inherit: props.inherit ?? null,
                lootTable: pprops.lootTable ?? null,
                level: pprops.level ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (rec.cdbtype !== "element") continue;

        if (isMerchantTrainerElement(node)) {
            const npcUnit = pprops.npc?.unit ?? null;
            const icon = unitIcon(npcUnit, cdb.unitsById);

            outputs.merchants_trainers.push({
                ...baseRow(rec, mapped, "merchant_trainer", merchantTrainerLabel(node), icon),
                elementId: props.id ?? null,
                name: node.name ?? null,
                npcUnit,
                shop: pprops.shop ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (hasNpcProps(node)) {
            const npcUnit = pprops.npc?.unit ?? null;
            const icon = unitIcon(npcUnit, cdb.unitsById);

            outputs.npcs.push({
                ...baseRow(rec, mapped, "npc", npcLabel(node, cdb), icon),
                elementId: props.id ?? null,
                name: node.name ?? null,
                npcUnit,
                npcSkin: pprops.npc?.npcSkin ?? null,
                npcGear: pprops.npc?.npcGear ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (isRespawnElement(node)) {
            outputs.respawn_points.push({
                ...baseRow(rec, mapped, "respawn_point", humanize(node.name || props.id || "Respawn"), null),
                elementId: props.id ?? null,
                name: node.name ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (isChestElement(node)) {
            outputs.chests.push({
                ...baseRow(rec, mapped, "chest", chestLabel(node), null),
                elementId: props.id ?? null,
                name: node.name ?? null,
                lootTable: pprops.lootTable ?? null,
                level: pprops.level ?? null,
                lootItems: pprops.lootItems ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (isOreElement(node)) {
            outputs.ores.push({
                ...baseRow(rec, mapped, "ore", gatherableLabelFromName(node.name || props.id || "Ore"), null),
                elementId: props.id ?? null,
                name: node.name ?? null,
                source: node.source ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (isGatherableElement(node)) {
            outputs.gatherables.push({
                ...baseRow(rec, mapped, "gatherable", gatherableLabelFromName(node.name || props.id || "Gatherable"), null),
                elementId: props.id ?? null,
                name: node.name ?? null,
                source: node.source ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }

        if (isTraversalElement(node)) {
            outputs.traversal_pois.push({
                ...baseRow(rec, mapped, "traversal_poi", humanize(node.name || props.id || "Traversal"), null),
                elementId: props.id ?? null,
                name: node.name ?? null,
                source: node.source ?? null,
                raw: {
                    ...props,
                    chunkId: rec.chunkId,
                    worldX: mapped.worldX,
                    worldY: mapped.worldY,
                },
            });
            continue;
        }
    }

    return outputs;
}

function sortRows(rows) {
    return rows.sort((a, b) =>
        a.label.localeCompare(b.label) ||
        a.chunkId.localeCompare(b.chunkId) ||
        a.id.localeCompare(b.id)
    );
}

function dumpMapPois({ worldRootDir, minimapDir, worldPrefabPath, cdbPath, outDir }) {
    const worldParams = loadWorldParams(worldPrefabPath);
    const minimapMeta = loadMinimapMeta(minimapDir, worldParams.tileWorld);
    const cdb = loadCdbLookups(cdbPath);

    const records = extractWorldNodes(worldRootDir, worldParams.loadedChunkIds);
    const outputs = buildOutputs(records, minimapMeta, worldParams, cdb);

    ensureDir(outDir);

    for (const [key, rows] of Object.entries(outputs)) {
    const sorted = sortRows(rows);
    const filePath = path.join(outDir, `${key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(sorted, null, 4), "utf8");
  }

  const manifest = {
        loadedChunkCount: worldParams.loadedChunkIds.size,
        gameplayBaseChunkSize: worldParams.gameplayBaseChunkSize,
        tileWorld: worldParams.tileWorld,
        minimap: minimapMeta,
        counts: Object.fromEntries(
            Object.entries(outputs).map(([k, v]) => [k, v.length])
        ),
    };
    fs.writeFileSync(
    path.join(outDir, "_manifest.json"),
    JSON.stringify(manifest, null, 4),
    "utf8"
  );
  return {
    outDir,
    loadedChunkCount: worldParams.loadedChunkIds.size,
    gameplayBaseChunkSize: worldParams.gameplayBaseChunkSize,
    tileWorld: worldParams.tileWorld,
    scannedNodeCount: records.length,
    counts: manifest.counts,
    manifestPath: path.join(outDir, "_manifest.json"),
  };
}

function main(argv = process.argv) {
    const worldRootDir = argv[2];
    const minimapDir = argv[3];
    const worldPrefabPath = argv[4];
    const cdbPath = argv[5];
    const outDir = argv[6];

    if (!worldRootDir || !minimapDir || !worldPrefabPath || !cdbPath || !outDir) {
        throw new Error(
            "Usage: node dump-pois.cjs <worldRootDir> <minimapDir> <worldPrefabPath> <cdbPath> <outDir>"
        );
    }

    dumpMapPois({ worldRootDir, minimapDir, worldPrefabPath, cdbPath, outDir });
}

module.exports = {
    dumpMapPois,
};

if (require.main === module) {
    main();
}
