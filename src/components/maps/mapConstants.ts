export const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";

export const MAPTILER_STREETS_STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : "";

export const OPENFREEMAP_VECTOR_STYLE_URL =
  "https://tiles.openfreemap.org/styles/liberty";

export const OSM_RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export const ROADMAP_STYLE =
  MAPTILER_STREETS_STYLE_URL || OPENFREEMAP_VECTOR_STYLE_URL;
export const USES_MAPTILER_STREETS = Boolean(MAPTILER_STREETS_STYLE_URL);
