import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#j-count");
    const searchEl = document.querySelector<HTMLInputElement>("#j-search");
    if (!countEl || !searchEl) return;

    const jobs = await fetch(generatedUrl("data/jobs.json", BASE)).then((r) => r.json());
    countEl.textContent = `${jobs.length.toLocaleString()} jobs`;

    const table = new Tabulator("#j-table", {
        data: jobs,
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
                    const src = icon(cell.getValue() ? String(cell.getValue()) : null, BASE);
                    return src
                        ? `<img class="icon" src="${src}" width="36" height="36" loading="lazy" decoding="async">`
                        : "";
                },
            },
            { title: "ID", field: "id", width: 220 },
            { title: "Name", field: "texts.name", minWidth: 220 },
            { title: "Tool Type", field: "toolType", width: 200 },
            {
                title: "Desc",
                field: "texts.desc",
                minWidth: 420,
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
        window.location.assign(url(`jobs/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const hay = `${data.id ?? ""} ${data.texts?.name ?? ""} ${data.texts?.desc ?? ""} ${data.toolType ?? ""}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${jobs.length.toLocaleString()} jobs`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
