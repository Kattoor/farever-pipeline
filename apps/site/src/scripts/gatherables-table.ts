import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, baseUrl } from "../lib/urls";

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#g-count");
    const searchEl = document.querySelector<HTMLInputElement>("#g-search");
    if (!countEl || !searchEl) return;

    const g = await fetch(generatedUrl("data/gatherable.json", BASE)).then((r) => r.json());
    countEl.textContent = `${g.length.toLocaleString()} gatherables`;

    const table = new Tabulator("#g-table", {
        data: g,
        height: "72vh",
        layout: "fitColumns",
        rowHeight: 48,
        renderVertical: "virtual",
        renderVerticalBuffer: 200,
        columns: [
            { title: "ID", field: "id", width: 260 },
            { title: "Name", field: "texts.name", minWidth: 220 },
            { title: "Type", field: "texts.type", width: 160 },
            { title: "Required Tool", field: "requiredTool", width: 180 },
            { title: "Hit Loot", field: "hitLoot", width: 220 },
            {
                title: "Desc",
                field: "texts.desc",
                minWidth: 360,
                formatter: (cell) => {
                    const raw = String(cell.getValue() ?? "");
                    const single = raw.replace(/\s+/g, " ").trim();
                    return `<span class="desc-preview" title="${raw.replaceAll('"', "&quot;")}">${single}</span>`;
                },
            },
        ],
    });

    table.on("rowClick", (_e, row) => {
        const id = String(row.getData().id ?? "");
        window.location.assign(url(`gatherables/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const hay = `${data.id ?? ""} ${data.hitLoot ?? ""} ${data.requiredTool ?? ""} ${data.texts?.name ?? ""} ${data.texts?.desc ?? ""}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${g.length.toLocaleString()} gatherables`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
