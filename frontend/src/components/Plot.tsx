import type { Config, Data, Layout, PlotMouseEvent } from "plotly.js";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type PlotlyModule = typeof import("plotly.js");

let plotlyModule: Promise<PlotlyModule> | null = null;

/** Plotly is several megabytes, so it loads on first use; calling this early warms the cache. */
export function loadPlotly(): Promise<PlotlyModule> {
  plotlyModule ??= import("plotly.js-dist-min").then((module) => module.default);
  return plotlyModule;
}

const BASE_CONFIG: Partial<Config> = { displayModeBar: false, responsive: true, displaylogo: false };

type PlotProps = {
  data: Data[];
  layout: Partial<Layout>;
  label: string;
  height: number;
  onPointClick?: (event: PlotMouseEvent) => void;
  className?: string;
};

export function Plot({ data, layout, label, height, onPointClick, className }: PlotProps) {
  const container = useRef<HTMLDivElement>(null);
  const listening = useRef(false);
  const [plotly, setPlotly] = useState<PlotlyModule | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const handleClick = useEffectEvent((event: PlotMouseEvent) => onPointClick?.(event));

  useEffect(() => {
    let active = true;
    loadPlotly().then(
      (module) => active && setPlotly(() => module),
      () => active && setLoadFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!plotly || !element) return;
    void plotly.react(element, data, { ...layout, height }, BASE_CONFIG).then((plot) => {
      if (listening.current) return;
      listening.current = true;
      plot.on("plotly_click", (event) => handleClick(event));
    });
  }, [plotly, data, layout, height]);

  useEffect(() => {
    const element = container.current;
    if (!plotly || !element) return;
    const observer = new ResizeObserver(() => plotly.Plots.resize(element));
    observer.observe(element);
    return () => {
      observer.disconnect();
      plotly.purge(element);
      listening.current = false;
    };
  }, [plotly]);

  return (
    <div className={cn("relative", className)} style={{ height }}>
      <div ref={container} role="img" aria-label={label} className="h-full w-full" />
      {plotly ? null : (
        <div className="absolute inset-0 grid place-items-center text-sm text-ink-3">
          {loadFailed ? "The chart could not load. Reload the page to try again." : "Loading chart…"}
        </div>
      )}
    </div>
  );
}
