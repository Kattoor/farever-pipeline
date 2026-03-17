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
    // <tileX>_<tileY>_<tileRes>.png
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

function mapSpawnerToPixel(spawn, minimapMeta, gameplayBaseChunkSize) {
    const chunkSize = gameplayBaseChunkSize * (1 << spawn.level);

    // This is the mapping that matched your correct result.
    const worldX = (spawn.I - 0.5) * chunkSize + spawn.localAbsX;
    const worldY = (spawn.J - 0.5) * chunkSize + spawn.localAbsY;

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

function extractMobSpawns(worldRootDir, loadedChunkIds) {
    const gameplayFiles = listGameplayPrefabs(worldRootDir);
    const spawns = [];

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
                if (props.$cdbtype !== "spawner") return;

                const unitId = props.unit ?? null;
                const unitGroup = props.unitGroup ?? null;

                // Only mobs here; skip non-unit spawners if any exist.
                if (!unitId && !unitGroup) return;

                const pos = applyT(absT, 0, 0);

                spawns.push({
                    file: fp,
                    chunkId: chunk.id,
                    level: chunk.level,
                    I: chunk.I,
                    J: chunk.J,
                    localAbsX: pos.x,
                    localAbsY: pos.y,
                    unitId,
                    unitGroup,
                    rawProps: props,
                });
            });
        }
    }

    return spawns;
}

function buildMobRows(spawns, minimapMeta, worldParams, cdb) {
    return spawns.map((spawn, index) => {
        const mapped = mapSpawnerToPixel(
            spawn,
            minimapMeta,
            worldParams.gameplayBaseChunkSize
        );

        const label =
            unitLabel(spawn.unitId, cdb.unitsById) ||
            unitGroupPreview(spawn.unitGroup, cdb.unitGroupsById, cdb.unitsById) ||
            spawn.unitId ||
            spawn.unitGroup ||
            `Mob ${index + 1}`;

        const icon = iconForSpawn(
            spawn.unitId,
            spawn.unitGroup,
            cdb.unitsById,
            cdb.unitGroupsById
        );

        return {
            id: `mob-${spawn.chunkId}-${spawn.unitId || spawn.unitGroup || index}-${index}`,
            type: "mob",
            label,
            unitId: spawn.unitId,
            unitGroup: spawn.unitGroup,
            icon,
            px: mapped.px,
            py: mapped.py,
            worldX: mapped.worldX,
            worldY: mapped.worldY,
            chunkId: spawn.chunkId,
            file: spawn.file,
            raw: {
                ...spawn.rawProps,
                chunkId: spawn.chunkId,
                worldX: mapped.worldX,
                worldY: mapped.worldY,
            },
        };
    }).filter(row => Number.isFinite(row.px) && Number.isFinite(row.py));
}

function dumpMapMobs({ worldRootDir, minimapDir, worldPrefabPath, cdbPath, outPath }) {
    const worldParams = loadWorldParams(worldPrefabPath);
    const minimapMeta = loadMinimapMeta(minimapDir, worldParams.tileWorld);
    const cdb = loadCdbLookups(cdbPath);

    const spawns = extractMobSpawns(worldRootDir, worldParams.loadedChunkIds);
    const rows = buildMobRows(spawns, minimapMeta, worldParams, cdb);

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 4), "utf8");
  return {
    outPath,
    loadedChunkCount: worldParams.loadedChunkIds.size,
    gameplayBaseChunkSize: worldParams.gameplayBaseChunkSize,
    tileWorld: worldParams.tileWorld,
    spawnCount: spawns.length,
    rowCount: rows.length,
  };
}

function main(argv = process.argv) {
    const worldRootDir = argv[2];
    const minimapDir = argv[3];
    const worldPrefabPath = argv[4];
    const cdbPath = argv[5];
    const outPath = argv[6];

    if (!worldRootDir || !minimapDir || !worldPrefabPath || !cdbPath || !outPath) {
        throw new Error(
            "Usage: node dump-mobs.cjs <worldRootDir> <minimapDir> <worldPrefabPath> <cdbPath> <outPath>"
        );
    }

    dumpMapMobs({ worldRootDir, minimapDir, worldPrefabPath, cdbPath, outPath });
}

module.exports = {
    dumpMapMobs,
};

if (require.main === module) {
    main();
}
