import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#items-count");
    const searchEl = document.querySelector<HTMLInputElement>("#items-search");
    if (!countEl || !searchEl) return;

    let items = await fetch(generatedUrl("data/items.json", BASE)).then((r) => r.json());
    // Protect build/runtime against bad rows with empty ids
    items = items.filter((it: any) => typeof it?.id === "string" && it.id.trim().length > 0);

    countEl.textContent = `${items.length.toLocaleString()} items`;

    const table = new Tabulator("#items-table", {
        data: items,
        height: "72vh",
        layout: "fitColumns",
        rowHeight: 52,
        renderVertical: "virtual",
        renderVerticalBuffer: 200,
        columns: [
            {
                title: "",
                field: "gfx.file",
                width: 64,
                headerSort: false,
                hozAlign: "center",
                formatter: (cell) => {
                    const file = cell.getValue();
                    const src = icon(file ? String(file) : null, BASE);
                    return src
                        ? `<img class="icon" src="${src}" width="36" height="36" loading="lazy" decoding="async">`
                        : "";
                },
            },
            { title: "ID", field: "id", width: 260 },
            { title: "Name", field: "texts.name", minWidth: 240 },
            { title: "Type", field: "type", width: 160 },
            { title: "Rarity", field: "rarity", width: 140 },
            { title: "Level", field: "level", width: 90, sorter: "number" },
        ],
    });

    table.on("rowClick", (_e, row) => {
        const id = String(row.getData().id ?? "");
        if (!id.trim()) return;
        window.location.assign(url(`items/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const hay = `${data.id ?? ""} ${data.type ?? ""} ${data.rarity ?? ""} ${data.texts?.name ?? ""}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${items.length.toLocaleString()} items`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
