import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

function esc(s: string) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function pct(p: any): string {
    const n = Number(p);
    if (!Number.isFinite(n)) return "—";
    return `${Math.round(n * 1000) / 10}%`; // 1 decimal
}

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#loot-count");
    const searchEl = document.querySelector<HTMLInputElement>("#loot-search");
    if (!countEl || !searchEl) return;

    const [tables, items] = await Promise.all([
        fetch(generatedUrl("data/loot-tables.json", BASE)).then((r) => r.json()),
        fetch(generatedUrl("data/items.json", BASE)).then((r) => r.json()),
    ]);

    const itemById = new Map<string, any>();
    for (const it of items) {
        if (typeof it?.id === "string" && it.id.trim()) itemById.set(it.id, it);
    }

    countEl.textContent = `${tables.length.toLocaleString()} tables`;

    const renderDirectDrops = (loot: any[], limit = 6) => {
        const drops = loot.filter((e) => e?.item);
        if (!drops.length) return ""; // ✅ no filler line

        const shown = drops.slice(0, limit).map((e: any) => {
            const id = String(e.item);
            const it = itemById.get(id);
            const name = it?.texts?.name ?? id;
            const file = it?.gfx?.file;
            const img = file ? icon(String(file), BASE) : null;

            const tip = esc(name);
            const href = url(`items/${encodeURIComponent(id)}/`, BASE);

            return `
        <span class="item-chip tip" data-tip="${tip}">
          ${img ? `<img src="${img}" alt="${tip}" loading="lazy" decoding="async">` : ""}
          <span class="chip-meta">${pct(e.proba)}</span>
          <a href="${href}">${esc(name)}</a>
        </span>
      `;
        });

        const extra = drops.length > limit ? `<span class="chip-meta">+${drops.length - limit}</span>` : "";
        return `<div class="chip-row">${shown.join("")}${extra}</div>`;
    };

    const renderIncludedTables = (loot: any[], limit = 10) => {
        const refs = loot.filter((e) => e?.lootTable);
        if (!refs.length) return ""; // ✅ no filler line

        const shown = refs.slice(0, limit).map((e: any) => {
            const id = String(e.lootTable);
            const href = url(`loot-tables/${encodeURIComponent(id)}/`, BASE);
            return `
        <a class="pill chip-pill" href="${href}">
          <span class="chip-meta">${pct(e.proba)}</span>
          <code>${esc(id)}</code>
        </a>
      `;
        });

        const extra = refs.length > limit ? `<span class="chip-meta">+${refs.length - limit}</span>` : "";
        return `<div class="chip-row">${shown.join("")}${extra}</div>`;
    };

    const table = new Tabulator("#loot-table", {
        data: tables,
        height: "72vh",
        layout: "fitColumns",
        // ✅ remove fixed rowHeight so wrapped chips can expand cell height naturally
        renderVertical: "virtual",
        renderVerticalBuffer: 240,
        columns: [
            { title: "ID", field: "id", width: 260 },
            {
                title: "Direct drops",
                field: "loot",
                minWidth: 540,
                cssClass: "cell-wrap", // ✅ allow wrapping for this column
                formatter: (cell) => {
                    const loot = cell.getValue();
                    if (!Array.isArray(loot) || !loot.length) return "";
                    return renderDirectDrops(loot, 6);
                },
            },
            {
                title: "Included tables",
                field: "loot",
                minWidth: 420,
                cssClass: "cell-wrap", // ✅ allow wrapping for this column
                formatter: (cell) => {
                    const loot = cell.getValue();
                    if (!Array.isArray(loot) || !loot.length) return "";
                    return renderIncludedTables(loot, 10);
                },
            },
        ],
    });

    table.on("rowClick", (_e, row) => {
        const id = String(row.getData().id ?? "");
        window.location.assign(url(`loot-tables/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        return String(data.id ?? "").toLowerCase().includes(params.q.toLowerCase());
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${tables.length.toLocaleString()} tables`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
