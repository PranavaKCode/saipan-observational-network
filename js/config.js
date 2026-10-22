/* ==========================================================================
   config.js - deployment-specific values
   --------------------------------------------------------------------------
   The CARTO basemap key does not live in this file, and it is not in version
   control. It sits in `js/carto-key.js`, which is gitignored; copy
   `js/carto-key.example.js` to that name and put your own key in it.

   Why bother, when every map tile is fetched by the browser and the key is
   therefore readable in the deployed page source anyway? Because the two
   exposures are not the same size. Reading it out of deployed JavaScript
   takes someone deciding to look at this particular site. A key committed to
   a public repository gets found by bots that scan GitHub for exactly this,
   continuously, across every repository there is.

   So the key ships to the host and stays out of the history.

   Three things keep it workable:

     1. Restrict the key to the deployed domain in the CARTO dashboard. That
        is the control that actually protects it; everything else is friction.
     2. The free tier allows 5,000,000 tile requests a month, and the service
        worker caches tiles hard, so a returning reader costs almost nothing.
     3. With no key at all the app still runs. CARTO's raster endpoint serves
        unkeyed requests, and Esri imagery - the default base layer - needs no
        key either. A fresh clone works; it is just not using your quota.
   ========================================================================== */

/** CARTO raster basemap styles this app uses. */
export const CARTO_STYLES = {
  light: 'voyager',
  dark: 'dark_all',
};

let cartoKey = '';

export function setCartoKey(key) {
  cartoKey = typeof key === 'string' ? key.trim() : '';
}

export function hasCartoKey() {
  return cartoKey.length > 0;
}

/**
 * Tile URL template for a CARTO raster style.
 * Without a key the same endpoint still serves tiles, so the map degrades to
 * unkeyed usage rather than breaking.
 */
export function cartoUrl(style) {
  const base = `https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png`;
  return cartoKey ? `${base}?key=${encodeURIComponent(cartoKey)}` : base;
}

/**
 * Load the untracked key file, if this deployment has one.
 * A missing file is the normal state of a fresh clone, so it is caught and
 * ignored rather than allowed to take the whole module graph down with it.
 */
export async function loadCartoKey() {
  try {
    const mod = await import('./carto-key.js');
    setCartoKey(mod.CARTO_KEY);
    return hasCartoKey();
  } catch {
    return false;
  }
}
