import { useEffect, useRef } from "react";

interface WaveformProps {
  /** Function returning current bar amplitudes in [0,1]. Polled @ rAF. */
  getBars: () => number[];
  bars?: number;
  className?: string;
  /** Set false to freeze rendering (e.g. during processing state). */
  active?: boolean;
}

export function Waveform({ getBars, bars = 32, className, active = true }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const valuesRef = useRef<number[]>(new Array(bars).fill(0));

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const incoming = getBars();
      const smoothed = valuesRef.current;
      for (let i = 0; i < bars; i++) {
        const target = incoming[i] ?? 0;
        // Exponential smoothing per bar (plan §10 — Motion).
        smoothed[i] = smoothed[i] * 0.55 + target * 0.45;
      }

      const barW = (w / bars) * 0.55;
      const gap = (w / bars) * 0.45;
      const centerY = h / 2;
      const maxBar = h * 0.85;

      // Gradient violet → cyan
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#A855F7");
      grad.addColorStop(1, "#22D3EE");
      ctx.fillStyle = grad;

      for (let i = 0; i < bars; i++) {
        const amp = Math.max(0.06, smoothed[i]); // floor so bars never disappear
        const barH = amp * maxBar;
        const x = i * (barW + gap) + gap / 2;
        const y = centerY - barH / 2;
        // Rounded rect
        const r = Math.min(barW / 2, barH / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + barW, y, x + barW, y + barH, r);
        ctx.arcTo(x + barW, y + barH, x, y + barH, r);
        ctx.arcTo(x, y + barH, x, y, r);
        ctx.arcTo(x, y, x + barW, y, r);
        ctx.closePath();
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [getBars, bars, active]);

  return <canvas ref={canvasRef} className={className} />;
}
