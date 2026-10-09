import { useId } from "react";

/**
 * MaxDrive mark: a stack of platters - several drives presented as one volume.
 * Inline SVG so it stays crisp at any size and needs no file load.
 * Keep in sync with public/assets/logo.svg (the source for the app icon).
 */
export function Logo({ size = 32, className = "" }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="MaxDrive"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4C8DF6" />
          <stop offset="55%" stopColor="#1A73E8" />
          <stop offset="100%" stopColor="#0B57D0" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${gradientId})`} />
      <g fill="#FFFFFF">
        <path
          d="M138 344a118 40 0 0 0 236 0v34a118 40 0 0 1-236 0z"
          opacity="0.55"
        />
        <ellipse cx="256" cy="344" rx="118" ry="40" opacity="0.62" />
        <path
          d="M138 256a118 40 0 0 0 236 0v34a118 40 0 0 1-236 0z"
          opacity="0.72"
        />
        <ellipse cx="256" cy="256" rx="118" ry="40" opacity="0.8" />
        <path
          d="M138 168a118 40 0 0 0 236 0v34a118 40 0 0 1-236 0z"
          opacity="0.88"
        />
        <ellipse cx="256" cy="168" rx="118" ry="40" opacity="0.97" />
      </g>
    </svg>
  );
}
