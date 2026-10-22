/* Copy this file to js/carto-key.js and paste in your own CARTO key.

   Get one free at https://carto.com/basemaps/ (5,000,000 tile requests a
   month). Then restrict it to the domain you deploy to, in the CARTO
   dashboard - that restriction, not secrecy, is what protects it, because
   the browser has to send the key with every tile request.

   Without this file the app still runs: CARTO's raster endpoint serves
   unkeyed requests, and the default Esri imagery base needs no key. */
export const CARTO_KEY = '';
