import { C } from "./theme.js";

/**
 * Brand-Spinner — on-brand loading indicator built around the lokyy
 * brain-mark. A simplified brain silhouette in `color` sits in the
 * centre, gently pulsing, while a single orange arc orbits around it
 * — the arc gives the eye a clear motion cue at small sizes, the
 * brain glyph anchors it to the product identity.
 *
 * Visual:
 *   - Circular arc (3/4 of a stroke ring) rotating at 1.2s linear.
 *   - Centre brain silhouette pulsing opacity 0.55 → 1 → 0.55 at 1.5s.
 *   - All geometry in a 24×24 viewBox, scaled via `size` (default 16).
 *   - Uses inline `<style>` with a unique animation-id suffix so
 *     multiple spinners on the same page don't share keyframe scope.
 *
 * No new deps — pure SVG + CSS @keyframes.
 */

export interface SpinnerProps {
  /** Outer width/height in px. Default 16. */
  size?: number;
  /** Stroke + fill colour. Default brand accent (orange). */
  color?: string;
  /** Optional aria-label override. Default "loading". */
  label?: string;
  /** Optional inline-style escape hatch (margin, vertical-align, etc). */
  style?: React.CSSProperties;
  /** Optional className for additional styling. */
  className?: string;
}

// Stable id per module load — keyframe names are global, but two
// spinners with the same names are fine because the animation
// definition is identical. We still namespace to keep dev-tools clean.
const KEYFRAMES_ID = "lokyy-spinner-keyframes";

/**
 * Simplified brain outline derived from the lokyy logo: two rounded
 * hemispheres meeting at a central sulcus, plus a hint of cortex
 * folding via the inner stroke. Built to read at 12-16px.
 */
const BRAIN_PATH =
  "M12 4.5c-1.6 0-2.9 1-3.4 2.3-1.4.1-2.6 1.1-2.6 2.6 0 .6.2 1.1.5 1.5-.4.4-.6 1-.6 1.6 0 1.3 1 2.4 2.3 2.5.3 1.3 1.4 2.3 2.8 2.3.4 0 .8-.1 1.1-.2.3.1.7.2 1.1.2 1.4 0 2.5-1 2.8-2.3 1.3-.1 2.3-1.2 2.3-2.5 0-.6-.2-1.2-.6-1.6.3-.4.5-.9.5-1.5 0-1.5-1.2-2.5-2.6-2.6C14.9 5.5 13.6 4.5 12 4.5z M12 4.5v11.8";

export function Spinner({
  size = 16,
  color = C.accent,
  label = "loading",
  style,
  className,
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        lineHeight: 0,
        ...style,
      }}
    >
      <style>{`
        @keyframes lokyy-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes lokyy-pulse {
          0%, 100% { opacity: 0.55; }
          50%      { opacity: 1; }
        }
        .${KEYFRAMES_ID}-orbit {
          transform-origin: 50% 50%;
          animation: lokyy-spin 1.2s linear infinite;
        }
        .${KEYFRAMES_ID}-brain {
          transform-origin: 50% 50%;
          animation: lokyy-pulse 1.5s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .${KEYFRAMES_ID}-orbit  { animation: none; }
          .${KEYFRAMES_ID}-brain  { animation: none; opacity: 0.85; }
        }
      `}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Orbiting arc — 270° of a circle, leaving a gap so the
            rotation reads clearly. */}
        <g className={`${KEYFRAMES_ID}-orbit`}>
          <path
            d="M22 12a10 10 0 1 1-7.07-9.54"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </g>
        {/* Centre brain silhouette, smaller than the orbit so the
            arc visibly rings around it. */}
        <g className={`${KEYFRAMES_ID}-brain`}>
          <path
            d={BRAIN_PATH}
            stroke={color}
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            transform="translate(0 0) scale(0.7) translate(5.1 5.1)"
          />
        </g>
      </svg>
    </span>
  );
}

export default Spinner;
