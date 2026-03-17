import { TabulatorFull as Tabulator } from "tabulator-tables";
import { generatedUrl, url, icon, baseUrl } from "../lib/urls";

function esc(s: string) {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function main() {
    const BASE = baseUrl();
    const countEl = document.querySelector("#c-count");
    const searchEl = document.querySelector<HTMLInputElement>("#c-search");
    if (!countEl || !searchEl) return;

    const [crafts, items] = await Promise.all([
        fetch(generatedUrl("data/craft.json", BASE)).then((r) => r.json()),
        fetch(generatedUrl("data/items.json", BASE)).then((r) => r.json()),
    ]);

    const itemById = new Map<string, any>();
    for (const it of items) {
        if (typeof it?.id === "string" && it.id.trim()) itemById.set(it.id, it);
    }

    const itemName = (id: string) => itemById.get(id)?.texts?.name ?? id;
    const itemIcon = (id: string) => {
        const f = itemById.get(id)?.gfx?.file;
        return f ? icon(String(f), BASE) : null;
    };

    countEl.textContent = `${crafts.length.toLocaleString()} crafts`;

    const table = new Tabulator("#c-table", {
        data: crafts,
        height: "72vh",
        layout: "fitColumns",
        rowHeight: 52,
        renderVertical: "virtual",
        renderVerticalBuffer: 200,
        columns: [
            {
                title: "Output",
                field: "item",
                width: 340,
                formatter: (cell) => {
                    const id = String(cell.getValue() ?? "");
                    const nm = itemName(id);
                    const ic = itemIcon(id);
                    const tip = esc(nm);
                    const href = url(`items/${encodeURIComponent(id)}/`, BASE);
                    return `
            <span class="item-chip tip" data-tip="${tip}">
              ${ic ? `<img src="${ic}" alt="${tip}" loading="lazy" decoding="async">` : ""}
              <a href="${href}">${esc(nm)}</a>
              <span class="muted">(<code>${esc(id)}</code>)</span>
            </span>
          `;
                },
            },
            { title: "Job", field: "job", width: 160 },
            { title: "Level", field: "level", width: 90, sorter: "number" },
            {
                title: "Inputs",
                field: "input",
                minWidth: 520,
                formatter: (cell) => {
                    const input = cell.getValue();
                    if (!Array.isArray(input) || !input.length) return `<span class="muted">—</span>`;

                    // Show up to 6 inline chips; rest as "+N"
                    const shown = input.slice(0, 6).map((x: any) => {
                        const id = String(x.item ?? "");
                        const nm = itemName(id);
                        const ic = itemIcon(id);
                        const tip = esc(nm);
                        const href = url(`items/${encodeURIComponent(id)}/`, BASE);
                        return `
              <span class="item-chip tip" data-tip="${tip}" style="margin-right:.5rem;">
                ${ic ? `<img src="${ic}" alt="${tip}" loading="lazy" decoding="async">` : ""}
                <code>${esc(String(x.count ?? ""))}</code>×
                <a href="${href}">${esc(nm)}</a>
              </span>
            `;
                    });

                    const extra = input.length > 6 ? `<span class="muted">+${input.length - 6}</span>` : "";
                    return shown.join("") + extra;
                },
            },
            { title: "Unlock", field: "unlockSource", width: 220 },
        ],
    });

    // Navigate to craft detail by output id
    table.on("rowClick", (_e, row) => {
        const out = String(row.getData().item ?? "");
        window.location.assign(url(`crafts/${encodeURIComponent(out)}/`, BASE));
    });

    function globalFilter(data: any, params: { q: string }) {
        const q = params.q.toLowerCase();
        const inputs = (data.input ?? []).map((x: any) => `${x.count}x ${x.item}`).join(" ");
        const hay = `${data.item ?? ""} ${data.job ?? ""} ${data.level ?? ""} ${data.unlockSource ?? ""} ${inputs}`.toLowerCase();
        return hay.includes(q);
    }

    searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (!q) {
            table.clearFilter(true);
            countEl.textContent = `${crafts.length.toLocaleString()} crafts`;
            return;
        }
        table.setFilter(globalFilter, { q });
        countEl.textContent = `${table.getDataCount("active").toLocaleString()} matched`;
    });
}

document.addEventListener("DOMContentLoaded", main);
