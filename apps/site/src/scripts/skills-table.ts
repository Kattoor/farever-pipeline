import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#skills-count");
    const searchEl = document.querySelector<HTMLInputElement>("#skills-search");
    if (!countEl || !searchEl) return;

    const skills = await fetch(generatedUrl("data/skills.json", BASE)).then((r) => r.json());
    countEl.textContent = `${skills.length.toLocaleString()} skills`;

    const table = new Tabulator("#skills-table", {
        data: skills,
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
                    return src ? `<img class="icon" src="${src}" width="36" height="36" loading="lazy" decoding="async">` : "";
                },
            },
            { title: "ID", field: "id", width: 320 },
            { title: "Name", field: "texts.name", minWidth: 260 },
            { title: "Nature", field: "nature", width: 120 },
            { title: "Type", field: "type", width: 120 },
            { title: "Cooldown", field: "cooldown", width: 120, sorter: "number" },
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
        window.location.assign(url(`skills/${encodeURIComponent(id)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const hay = `${data.id ?? ""} ${data.texts?.name ?? ""} ${data.texts?.desc ?? ""}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${skills.length.toLocaleString()} skills`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
