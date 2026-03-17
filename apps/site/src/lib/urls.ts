// src/lib/urls.ts
/** Base URL for the site. On GitHub Pages project sites this is "/REPO/". */
export function baseUrl(): string {
    // Astro/Vite provides this both in server build-time and client runtime.
    return (import.meta as any).env?.BASE_URL ?? "/";
}

const GENERATED_ASSET_ROOT = "generated";

function normalizePublicPath(value: string): string {
    return String(value ?? "")
        .replaceAll("\\", "/")
        .replace(/^\/+/, "");
}

/** Join BASE_URL with a relative path (no leading slash required). */
export function url(path: string, base: string = baseUrl()): string {
    return base + normalizePublicPath(path);
}

export function generatedPath(path: string): string {
    const rel = normalizePublicPath(path);
    if (!rel) return GENERATED_ASSET_ROOT;
    if (rel === GENERATED_ASSET_ROOT || rel.startsWith(`${GENERATED_ASSET_ROOT}/`)) return rel;
    return `${GENERATED_ASSET_ROOT}/${rel}`;
}

export function generatedUrl(path: string, base: string = baseUrl()): string {
    return url(generatedPath(path), base);
}

/**
 * Convert a game DB asset path like:
 *   UI/Portraits/Items/...png
 * into a site URL pointing to:
 *   <BASE_URL>/generated/icons/UI/Portraits/Items/...png
 *
 * Your filesystem should contain:
 *   public/generated/icons/UI/Portraits/Items/...png
 */
export function icon(gamePath: string | null | undefined, base: string = baseUrl()): string | null {
    if (!gamePath) return null;
    const p = normalizePublicPath(gamePath);

    // Prevent double-prefixing if some values already start with generated/ or icons/.
    if (p.startsWith(`${GENERATED_ASSET_ROOT}/`)) return url(p, base);
    if (p.startsWith("icons/")) return generatedUrl(p, base);

    return generatedUrl(`icons/${p}`, base);
}
