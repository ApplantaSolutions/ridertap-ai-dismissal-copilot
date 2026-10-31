/**
 * RiderTap official mark — "Logo 2: The Lanes R".
 *
 * Two curved road lanes sweep upward inside a deep-navy rounded square:
 * the LEFT lane in teal, the RIGHT lane in coral. Together they form a
 * capital R — the coral lane loops at the top right for the R's bowl and
 * kicks down diagonally for its leg. A coral location pin sits where the
 * lanes converge at the top, with a small teal sparkle at its upper right.
 * Each lane carries a subtle white dashed center line.
 *
 * Pure inline SVG so it stays crisp at every size, down to 32px.
 */
export function RiderTapLogo({
  size = 48,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="RiderTap logo — two lanes forming an R"
      className={`shrink-0 ${className}`}
    >
      {/* Deep navy badge */}
      <rect x="1" y="1" width="62" height="62" rx="15" fill="#0B1D3A" />

      {/* Road lanes (thick strokes underneath) */}
      {/* Left lane — teal, sweeping up */}
      <path
        d="M20 55 C20 42 21.5 30 26.5 19.5"
        fill="none"
        stroke="#15C5B6"
        strokeWidth="7.5"
        strokeLinecap="round"
      />
      {/* Right lane — coral: rises, loops into the R bowl */}
      <path
        d="M37 55 C37 44 37 32 37 21.5 C37 15 41.5 11 46.5 12.5 C51.5 14 52 20.5 47.5 23.5 C44 25.8 38.8 25.2 37 22.5"
        fill="none"
        stroke="#FF6B57"
        strokeWidth="7.5"
        strokeLinecap="round"
      />
      {/* Right lane — coral diagonal leg of the R */}
      <path
        d="M41.5 27.5 L51 55"
        fill="none"
        stroke="#FF6B57"
        strokeWidth="7.5"
        strokeLinecap="round"
      />

      {/* White dashed center lines */}
      <path
        d="M20 55 C20 42 21.5 30 26.5 19.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="2.6 3.6"
        opacity="0.95"
      />
      <path
        d="M37 55 C37 44 37 32 37 21.5 C37 15 41.5 11 46.5 12.5 C51.5 14 52 20.5 47.5 23.5 C44 25.8 38.8 25.2 37 22.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="2.6 3.6"
        opacity="0.95"
      />
      <path
        d="M41.5 27.5 L51 55"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="2.6 3.6"
        opacity="0.95"
      />

      {/* Location pin where the lanes converge */}
      <path
        d="M31 2.8 C27.4 2.8 24.8 5.6 24.8 8.9 C24.8 13.4 31 18.8 31 18.8 C31 18.8 37.2 13.4 37.2 8.9 C37.2 5.6 34.6 2.8 31 2.8 Z"
        fill="#FF6B57"
        stroke="#FFFFFF"
        strokeWidth="1.4"
      />
      <circle cx="31" cy="8.9" r="2.9" fill="#FFFFFF" />

      {/* Teal sparkle at the pin's upper right */}
      <path
        d="M44.5 0.5 L45.3 4.6 L49.4 5.4 L45.3 6.2 L44.5 10.3 L43.7 6.2 L39.6 5.4 L43.7 4.6 Z"
        fill="#2DD4BF"
      />
    </svg>
  );
}
