import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#attr-count");
    const searchEl = document.querySelector<HTMLInputElement>("#attr-search");
    if (!countEl || !searchEl) return;

    const attrs = await fetch(generatedUrl("data/attributes.json", BASE)).then((r) => r.json());
    countEl.textContent = `${attrs.length.toLocaleString()} attributes`;

    const table = new Tabulator("#attr-table", {
        data: attrs,
        height: "72vh",
        layout: "fitColumns",
        renderVertical: "virtual",
        renderVerticalBuffer: 240,
        columns: [
            {
                title: "",
                field: "gfx.file",
                width: 64,
                headerSort: false,
                hozAlign: "center",
                formatter: (cell) => {
                    const f = cell.getValue();
                    const src = f ? icon(String(f), BASE) : null;
                    return src ? `<img class="icon" src="${src}" width="28" height="28" loading="lazy" decoding="async">` : "";
                },
            },
            { title: "ID", field: "id", width: 280 },
            { title: "Name", field: "name", width: 220 },
            { title: "Desc", field: "desc", minWidth: 520 },
        ],
    });

    table.on("rowClick", (_e, row) => {
        const id = String(row.getData().id ?? "");
        window.location.assign(url(`attributes/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const hay = `${data.id ?? ""} ${data.name ?? ""} ${data.desc ?? ""}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${attrs.length.toLocaleString()} attributes`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
