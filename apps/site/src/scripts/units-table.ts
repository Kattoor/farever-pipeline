import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#units-count");
    const searchEl = document.querySelector<HTMLInputElement>("#units-search");
    if (!countEl || !searchEl) return;

    const units = await fetch(generatedUrl("data/units.json", BASE)).then((r) => r.json());
    countEl.textContent = `${units.length.toLocaleString()} units`;

    const table = new Tabulator("#units-table", {
        data: units,
        height: "72vh",
        layout: "fitColumns",
        rowHeight: 52,
        renderVertical: "virtual",
        renderVerticalBuffer: 200,
        columns: [
            {
                title: "",
                field: "gfx.file", // ✅ changed
                width: 64,
                headerSort: false,
                hozAlign: "center",
                formatter: (cell) => {
                    const src = icon(cell.getValue() ? String(cell.getValue()) : null, BASE);
                    return src
                        ? `<img class="icon" src="${src}" width="36" height="36" loading="lazy" decoding="async">`
                        : "";
                },
            },
            { title: "ID", field: "id", width: 280 },
            { title: "Name", field: "texts.name", minWidth: 260 },
            { title: "Type", field: "type", width: 180 },
            {
                title: "Description",
                field: "texts.desc",
                minWidth: 320,
                formatter: (cell) => {
                    const raw = String(cell.getValue() ?? "");
                    const singleLine = raw.replace(/\s+/g, " ").trim();
                    return `<span class="desc-preview" title="${raw.replaceAll('"', "&quot;")}">${singleLine}</span>`;
                },
            },
        ],
    });

    table.on("rowClick", (_e, row) => {
        const id = String(row.getData().id ?? "");
        window.location.assign(url(`units/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const hay = `${data.id ?? ""} ${data.type ?? ""} ${data.texts?.name ?? ""} ${data.texts?.desc ?? ""}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${units.length.toLocaleString()} units`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
