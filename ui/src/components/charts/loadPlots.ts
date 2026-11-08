// recharts loads on first use. Once loaded, a chart renders the plot directly: a lazy component
// suspends once even then, and React holds a revealed Suspense boundary back for up to 300 ms.
import type * as Plots from "./plots.tsx";

let loaded: typeof Plots | null = null;

export const loadPlots = () => import("./plots.tsx").then((plots) => (loaded = plots));

export const loadedPlots = () => loaded;
