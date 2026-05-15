/**
 * Subtle paper grain overlay — SVG feTurbulence fractal noise,
 * composited via mix-blend-mode so it feels like texture rather than noise.
 * Opacity is intentionally very low: you feel it, you don't see it.
 */
export function PaperGrain() {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 9999,
        opacity: 0.09,
        mixBlendMode: "soft-light",
      }}
    >
      <filter id="paper-grain" x="0%" y="0%" width="100%" height="100%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.72"
          numOctaves="4"
          seed="8"
          stitchTiles="stitch"
        />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#paper-grain)" />
    </svg>
  );
}
