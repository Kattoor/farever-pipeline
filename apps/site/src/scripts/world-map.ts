import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { generatedUrl, url, baseUrl } from "../lib/urls";

type MapMeta = {
  tileScheme?: string;
  tileFormat?: string;
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  width: number;
  height: number;
};

type Poi = {
  id: string;
  type: string;
  label: string;
  px: number;
  py: number;
  unitId?: string | null;
  unitGroup?: string | null;
  npcUnit?: string | null;
  icon?: string | null;
  raw: any;
};

const LAYER_FILES: Array<{ file: string; fallbackType: string }> = [
  { file: "mobs.json", fallbackType: "mob" },
  { file: "npcs.json", fallbackType: "npc" },
  { file: "ores.json", fallbackType: "ore" },
  { file: "gatherables.json", fallbackType: "gatherable" },
  { file: "chests.json", fallbackType: "chest" },
  { file: "activities.json", fallbackType: "activity" },
  { file: "merchants_trainers.json", fallbackType: "merchant_trainer" },
  { file: "respawn_points.json", fallbackType: "respawn_point" },
  { file: "traversal_pois.json", fallbackType: "traversal_poi" },
];

const TYPE_COLORS: Record<string, string> = {
  mob: "#ef4444",
  npc: "#60a5fa",
  ore: "#f59e0b",
  gatherable: "#22c55e",
  chest: "#eab308",
  activity: "#a855f7",
  merchant_trainer: "#14b8a6",
  respawn_point: "#f97316",
  traversal_poi: "#ec4899",
  poi: "#a78bfa",
  other: "#94a3b8",
};

function inferType(raw: any, fallbackType: string): string {
  const explicit = String(raw?.type ?? raw?.kind ?? raw?.layer ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  return fallbackType;
}

function normalizePois(input: any, fallbackType: string): Poi[] {
  const arr = Array.isArray(input) ? input : Array.isArray(input?.points) ? input.points : [];
  return arr
      .map((raw: any, index: number) => {
        const px = Number(raw?.px);
        const py = Number(raw?.py);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

        const type = inferType(raw, fallbackType);
        const label = String(
            raw?.label ??
            raw?.name ??
            raw?.texts?.name ??
            raw?.unitId ??
            raw?.npcUnit ??
            raw?.unitGroup ??
            raw?.elementId ??
            raw?.activityId ??
            raw?.id ??
            `${type}-${index}`,
        );

        return {
          id: String(raw?.id ?? `${type}-${index}`),
          type,
          label,
          px,
          py,
          unitId: raw?.unitId ?? raw?.unit ?? null,
          unitGroup: raw?.unitGroup ?? null,
          npcUnit: raw?.npcUnit ?? null,
          icon: raw?.icon ?? null,
          raw,
        } satisfies Poi;
      })
      .filter(Boolean) as Poi[];
}

async function fetchOptionalJson(p: string) {
  const res = await fetch(generatedUrl(p, baseUrl()));
  if (!res.ok) return null;
  return res.json();
}

function formatTitle(type: string): string {
  return type
      .replaceAll("_", " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
}

function renderDetails(poi: Poi) {
  const raw = poi.raw ?? {};
  const unitPageId = poi.unitId ?? poi.npcUnit ?? null;
  const unitHref = unitPageId
      ? url(`units/${encodeURIComponent(unitPageId)}/`, baseUrl())
      : null;

  const iconHtml = poi.icon
      ? `
      <div class="map-side-hero">
        <img
          class="map-side-icon"
          src="${escapeHtml(generatedUrl(poi.icon, baseUrl()))}"
          alt="${escapeHtml(poi.label)}"
          loading="lazy"
          decoding="async"
        />
      </div>
    `
      : "";

  return `
    <div class="map-side-card">
      <div class="map-side-kicker">${escapeHtml(formatTitle(poi.type))}</div>

      ${iconHtml}

      <h2>${escapeHtml(poi.label)}</h2>

      ${
      unitHref
          ? `
            <div class="map-side-actions">
              <a class="pill map-action-link" href="${escapeHtml(unitHref)}">
                Open unit page
              </a>
            </div>
          `
          : ""
  }

      <dl class="map-kv">
        <div><dt>ID</dt><dd><code>${escapeHtml(poi.id)}</code></dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(poi.type)}</dd></div>

        ${
      poi.unitId
          ? `<div><dt>Unit</dt><dd><a href="${escapeHtml(unitHref)}"><code>${escapeHtml(poi.unitId)}</code></a></dd></div>`
          : ""
  }

        ${
      poi.npcUnit && !poi.unitId
          ? `<div><dt>NPC Unit</dt><dd><a href="${escapeHtml(unitHref)}"><code>${escapeHtml(poi.npcUnit)}</code></a></dd></div>`
          : ""
  }

        ${
      poi.unitGroup
          ? `<div><dt>Unit group</dt><dd><code>${escapeHtml(poi.unitGroup)}</code></dd></div>`
          : ""
  }

        <div><dt>Pixel</dt><dd>${poi.px.toFixed(1)}, ${poi.py.toFixed(1)}</dd></div>

        ${
      Number.isFinite(raw?.worldX) && Number.isFinite(raw?.worldY)
          ? `<div><dt>World</dt><dd>${Number(raw.worldX).toFixed(1)}, ${Number(raw.worldY).toFixed(1)}</dd></div>`
          : ""
  }

        ${raw?.chunkId ? `<div><dt>Chunk</dt><dd><code>${escapeHtml(raw.chunkId)}</code></dd></div>` : ""}
        ${raw?.elementId ? `<div><dt>Element</dt><dd><code>${escapeHtml(raw.elementId)}</code></dd></div>` : ""}
        ${raw?.activityId ? `<div><dt>Activity</dt><dd><code>${escapeHtml(raw.activityId)}</code></dd></div>` : ""}
      </dl>

      <details class="map-raw-details">
        <summary>Raw data</summary>
        <pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
      </details>
    </div>
  `;
}

function updateStatus(statusEl: HTMLElement, total: number, visible: number) {
  statusEl.textContent = `${visible.toLocaleString()} / ${total.toLocaleString()} visible`;
}

function buildTypeControls(container: HTMLElement, points: Poi[]) {
  const counts = new Map<string, number>();
  for (const p of points) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);

  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  container.innerHTML = ordered
      .map(
          ([type, count]) => `
        <label class="pill map-filter-pill">
          <input type="checkbox" data-map-type value="${escapeHtml(type)}" checked />
          <span class="map-swatch" style="--swatch:${TYPE_COLORS[type] ?? TYPE_COLORS.other}"></span>
          <span>${escapeHtml(formatTitle(type))}</span>
          <span class="muted">${count.toLocaleString()}</span>
        </label>
      `,
      )
      .join("");
}

function selectedTypes(root: ParentNode): Set<string> {
  const set = new Set<string>();
  root.querySelectorAll<HTMLInputElement>('input[data-map-type]:checked').forEach((el) => set.add(el.value));
  return set;
}

function renderDefaultInfo(totalVisible: number) {
  return `
    <div class="map-side-card">
      <div class="map-side-kicker">Map</div>
      <h2>${totalVisible.toLocaleString()} points visible</h2>
      <p class="muted">Hover a point for a label, or click one to inspect its details here.</p>
    </div>
  `;
}

function getPoiSelectionKey(poi: Poi): string {
  // IDs are not guaranteed to be globally unique across all dumped map layers.
  return `${poi.type}::${poi.id}::${poi.px}::${poi.py}`;
}

async function main() {
  const mapRoot = document.querySelector<HTMLElement>("#world-map-root");
  const mapEl = document.querySelector<HTMLElement>("#world-map");
  const statusEl = document.querySelector<HTMLElement>("#map-status");
  const searchEl = document.querySelector<HTMLInputElement>("#map-search");
  const typesEl = document.querySelector<HTMLElement>("#map-type-filters");
  const infoEl = document.querySelector<HTMLElement>("#map-info");

  if (!mapRoot || !mapEl || !statusEl || !searchEl || !typesEl || !infoEl) return;

  const worldId = mapRoot.dataset.worldId ?? "w1-siagarta";

  try {
    statusEl.textContent = "Loading map...";

    const meta = await fetch(generatedUrl(`map/${worldId}/map.json`, baseUrl())).then((r) => {
      if (!r.ok) throw new Error(`Missing map metadata at /generated/map/${worldId}/map.json`);
      return r.json() as Promise<MapMeta>;
    });

    const loaded = await Promise.all(
        LAYER_FILES.map(async ({ file, fallbackType }) => {
          const data = await fetchOptionalJson(`data/maps/${worldId}/${file}`);
          if (!data) return [];
          return normalizePois(data, fallbackType);
        }),
    );

    const allPoints: Poi[] = loaded.flat();

    if (!allPoints.length) {
      throw new Error(
          `No POI data found. Expected split layer files like mobs.json / npcs.json / ores.json / gatherables.json in /public/generated/data/maps/${worldId}/`,
      );
    }

    buildTypeControls(typesEl, allPoints);

    const map = L.map(mapEl, {
      crs: L.CRS.Simple,
      minZoom: meta.minZoom,
      maxZoom: meta.maxZoom,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      preferCanvas: true,
      attributionControl: false,
    });

    const southWest = map.unproject([0, meta.height], meta.maxZoom);
    const northEast = map.unproject([meta.width, 0], meta.maxZoom);
    const bounds = L.latLngBounds(southWest, northEast);

    const tileExt = meta.tileFormat || "webp";
    L.tileLayer(generatedUrl(`map/${worldId}/{z}/{x}/{y}.${tileExt}`, baseUrl()), {
      tileSize: meta.tileSize,
      minZoom: meta.minZoom,
      maxZoom: meta.maxZoom,
      maxNativeZoom: meta.maxZoom,
      noWrap: true,
      bounds,
      keepBuffer: 4,
      updateWhenIdle: true,
    }).addTo(map);

    map.fitBounds(bounds, { padding: [12, 12] });
    map.setMaxBounds(bounds.pad(0.1));

    const renderer = L.canvas({ padding: 0.5 });
    const layerGroup = L.layerGroup().addTo(map);
    let selectedPoiKey: string | null = null;

    const render = () => {
      layerGroup.clearLayers();

      const query = searchEl.value.trim().toLowerCase();
      const activeTypes = selectedTypes(typesEl);

      const visible = allPoints.filter((poi) => {
        if (!activeTypes.has(poi.type)) return false;
        if (!query) return true;

        const hay = `${poi.label} ${poi.type} ${poi.unitId ?? ""} ${poi.npcUnit ?? ""} ${poi.unitGroup ?? ""} ${poi.id}`.toLowerCase();
        return hay.includes(query);
      });

      for (const poi of visible) {
        const latLng = map.unproject([poi.px, poi.py], meta.maxZoom);
        const color = TYPE_COLORS[poi.type] ?? TYPE_COLORS.other;

        const marker = L.circleMarker(latLng, {
          radius: 5,
          color: "#ffffff",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.9,
          renderer,
        });

        marker.bindTooltip(poi.label, {
          direction: "top",
          sticky: true,
          opacity: 0.95,
        });

        marker.on("click", () => {
          selectedPoiKey = getPoiSelectionKey(poi);
          infoEl.innerHTML = renderDetails(poi);
        });

        marker.addTo(layerGroup);
      }

      updateStatus(statusEl, allPoints.length, visible.length);

      if (selectedPoiKey) {
        const selectedPoi = visible.find((poi) => getPoiSelectionKey(poi) === selectedPoiKey) ?? null;
        if (selectedPoi) {
          infoEl.innerHTML = renderDetails(selectedPoi);
          return;
        }
        selectedPoiKey = null;
      }

      infoEl.innerHTML = renderDefaultInfo(visible.length);
    };

    searchEl.addEventListener("input", render);
    typesEl.addEventListener("change", render);

    render();
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    statusEl.textContent = "Map assets missing";
    infoEl.innerHTML = `
      <div class="map-side-card">
        <div class="map-side-kicker">Setup needed</div>
        <h2>Map assets not loaded</h2>
        <p class="muted">${escapeHtml(message)}</p>
        <p class="muted">Expected files:</p>
        <ul class="muted">
          <li><code>/public/generated/map/w1-siagarta/map.json</code></li>
          <li><code>/public/generated/map/w1-siagarta/&lt;z&gt;/&lt;x&gt;/&lt;y&gt;.webp</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/mobs.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/npcs.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/ores.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/gatherables.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/chests.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/activities.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/merchants_trainers.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/respawn_points.json</code></li>
          <li><code>/public/generated/data/maps/w1-siagarta/traversal_pois.json</code></li>
        </ul>
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", main);
