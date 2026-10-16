export const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";

export const MAPTILER_STREETS_STYLE_URL =
  `https://api.maptiler.com/maps/streets-v4/style.json?key=${MAPTILER_KEY}`;

export const MAPTILER_STREETS_RASTER_STYLE = {
  version: 8,
  sources: {
    maptilerStreets: {
      type: "raster",
      tiles: [
        `https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      ],
      tileSize: 256,
      maxzoom: 22,
      attribution: "© MapTiler © OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "maptiler-streets-raster",
      type: "raster",
      source: "maptilerStreets",
    },
  ],
};

export const ROADMAP_STYLE = MAPTILER_STREETS_STYLE_URL;
export const USES_MAPTILER_STREETS = Boolean(MAPTILER_STREETS_STYLE_URL);
