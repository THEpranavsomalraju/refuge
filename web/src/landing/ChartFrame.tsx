import { useEffect, useRef, useState } from 'react';
import type { ChartSpec } from './types';

/** '/charts/<id>/index.html' for a folder name, the URL itself for anything absolute. */
export function chartUrl(src: string): string {
  return /^(https?:)?\/\//.test(src) || src.startsWith('/') ? src : `/charts/${src}/index.html`;
}

// One standalone chart page in an iframe, so its scripts and CSS stay isolated from the app.
// A chart can size itself: parent.postMessage({ type: 'refuge:height', height }, '*').
export function ChartFrame({ chart }: { chart: ChartSpec }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(chart.height ?? 360);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const d = e.data as { type?: string; height?: number } | null;
      if (d?.type === 'refuge:height' && typeof d.height === 'number' && d.height > 0) setHeight(Math.ceil(d.height));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A missing chart folder falls back to the app's own index.html (marked with
  // <meta name="refuge-app">). Cross-origin charts can't be inspected, which is fine.
  const onLoad = () => {
    try {
      setMissing(!!ref.current?.contentDocument?.querySelector('meta[name="refuge-app"]'));
    } catch {
      setMissing(false);
    }
  };

  return (
    <figure className={`chart card${chart.wide ? ' chart-wide' : ''}`}>
      <figcaption className="label">{chart.title}</figcaption>
      {missing ? (
        <div className="chart-missing" style={{ height }}>
          Chart not found: <code>web/public/charts/{chart.src}/index.html</code>
        </div>
      ) : (
        <iframe ref={ref} src={chartUrl(chart.src)} title={chart.title} loading="lazy" onLoad={onLoad} style={{ height }} />
      )}
    </figure>
  );
}
