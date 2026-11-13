import type { ArmStyle } from "@/lib/domain";

const SHAPES: Record<string, string> = {
  circle: "M8 3.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9Z",
  square: "M4 4h8v8H4Z",
  diamond: "M8 2.5 13.5 8 8 13.5 2.5 8Z",
  "triangle-up": "M8 3 13 12.5H3Z",
  "triangle-down": "M3 3.5h10L8 13Z",
  hexagon: "M8 2.8 12.6 5.4v5.2L8 13.2 3.4 10.6V5.4Z",
  star: "M8 2.5l1.7 3.6 3.8.4-2.9 2.6.8 3.8L8 11l-3.4 1.9.8-3.8-2.9-2.6 3.8-.4Z",
  pentagon: "M8 2.8l5 3.6-1.9 5.8H4.9L3 6.4Z",
  x: "M3.5 5 5 3.5 8 6.5 11 3.5 12.5 5 9.5 8 12.5 11 11 12.5 8 9.5 5 12.5 3.5 11 6.5 8Z",
  cross: "M6.6 3h2.8v3.6H13v2.8H9.4V13H6.6V9.4H3V6.6h3.6Z",
  hourglass: "M4 3h8L8 8l4 5H4l4-5Z",
  bowtie: "M3 4l5 4 5-4v8l-5-4-5 4Z",
  hexagram: "M8 2.5l1.6 2.8h3.2L11.2 8l1.6 2.7H9.6L8 13.5 6.4 10.7H3.2L4.8 8 3.2 5.3h3.2Z",
  "star-diamond": "M8 2.5 9.2 6.8 13.5 8 9.2 9.2 8 13.5 6.8 9.2 2.5 8 6.8 6.8Z",
  "diamond-tall": "M8 2.5 11 8 8 13.5 5 8Z",
  octagon: "M6 3h4l3 3v4l-3 3H6l-3-3V6Z",
};

/** The arm's chart marker, so a table row or legend entry points at its points on the plot. A run
 * without its cofactor shows its dashed fit line behind the marker. */
export function ArmSwatch({ style, hollow = false, size = 16 }: { style: ArmStyle; hollow?: boolean; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" className="shrink-0">
      {style.dashed ? <line x1="0" y1="8" x2="16" y2="8" stroke={style.color} strokeWidth="1.6" strokeDasharray="3 2" /> : null}
      <path
        d={SHAPES[style.symbol] ?? SHAPES.circle}
        fill={hollow ? "#ffffff" : style.color}
        stroke={hollow ? style.color : "#ffffff"}
        strokeWidth={hollow ? 1.6 : 1}
        strokeLinejoin="round"
      />
    </svg>
  );
}
