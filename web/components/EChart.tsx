"use client";

import { useEffect, useRef } from "react";
import type { EChartsOption } from "echarts";

type EChartProps = {
  option: EChartsOption;
  height?: number;
  ariaLabel: string;
  onClick?: (params: { dataIndex?: number; seriesName?: string; name?: string }) => void;
};

export function EChart({ option, height = 300, ariaLabel, onClick }: EChartProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let chart: import("echarts").ECharts | undefined;
    let observer: ResizeObserver | undefined;
    let resize: (() => void) | undefined;
    let active = true;
    void import("echarts").then(({ init }) => {
      if (!elementRef.current || !active) return;
      const element = elementRef.current;
      chart = init(element, undefined, { renderer: "canvas" });
      chart.setOption(option);
      if (onClick) chart.on("click", onClick);
      resize = () => {
        if (chart && !chart.isDisposed()) chart.resize();
      };
      window.addEventListener("resize", resize);
      observer = new ResizeObserver(resize);
      observer.observe(element);
    });
    return () => {
      active = false;
      if (resize) window.removeEventListener("resize", resize);
      observer?.disconnect();
      if (chart && !chart.isDisposed()) chart.dispose();
    };
  }, [onClick, option]);

  return <div ref={elementRef} className="echart" style={{ height }} role="img" aria-label={ariaLabel} />;
}
