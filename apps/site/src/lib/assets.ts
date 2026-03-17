// src/lib/assets.ts
export function assetUrl(gamePath: string | null | undefined, baseUrl: string) {
    if (!gamePath) return null;

    // Normalize slashes and strip any leading slashes
    let p = String(gamePath).replaceAll("\\", "/").replace(/^\/+/, "");

    // If it already points into icons/, don't double-prefix
    if (p.startsWith("icons/")) return baseUrl + p;

    // Prefix everything else with icons/
    return baseUrl + "icons/" + p;
}