import { cn } from "@/lib/utils";

interface StrawberryLogoProps {
  className?: string;
}

export function StrawberryLogo({ className }: StrawberryLogoProps) {
  return (
    <svg viewBox="0 0 64 64" className={cn("size-6", className)} xmlns="http://www.w3.org/2000/svg">
      {/* Stem */}
      <path
        d="M32 8c0 0-.5 3-1 5s-.5 3-.5 3h3c0 0-.5-1-1-3s-.5-5-.5-5z"
        fill="#4a7c32"
      />
      {/* Leaves / calyx */}
      <path
        d="M32 14c-3-1-7 .5-9 2.5 1.5-.5 3.5-.5 5 0-2 .5-4 2-5 3.5 2-.5 4-.5 5.5.5C27 19 25 17.5 23 17c3-2.5 7-3.5 9-3zm0 0c3-1 7 .5 9 2.5-1.5-.5-3.5-.5-5 0 2 .5 4 2 5 3.5-2-.5-4-.5-5.5.5 1.5-1.5 3.5-3 5.5-3.5-3-2.5-7-3.5-9-3z"
        fill="#5c9e31"
      />
      {/* Berry body - main shape */}
      <path
        d="M32 18c-8 0-15 5-17 12-2 7 0 14 5 19 3 3.5 7 6 12 6s9-2.5 12-6c5-5 7-12 5-19-2-7-9-12-17-12z"
        fill="#e53935"
      />
      {/* Berry body - darker shade for depth */}
      <path
        d="M32 18c-8 0-15 5-17 12-2 7 0 14 5 19 3 3.5 7 6 12 6s9-2.5 12-6c5-5 7-12 5-19-2-7-9-12-17-12z"
        fill="url(#berry-gradient)"
      />
      {/* Highlight / shine */}
      <path
        d="M22 24c-1.5 2-2.5 5-2.5 8 0 1.5.2 3 .5 4.5.5-4 2-7.5 4.5-10 1.5-1.5 3-2.5 5-3-3 0-5.5.5-7.5 .5z"
        fill="white"
        opacity="0.2"
      />
      {/* Seeds */}
      <ellipse cx="25" cy="28" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(-15 25 28)" />
      <ellipse cx="32" cy="26" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(5 32 26)" />
      <ellipse cx="39" cy="29" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(15 39 29)" />
      <ellipse cx="22" cy="35" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(-10 22 35)" />
      <ellipse cx="29" cy="34" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(0 29 34)" />
      <ellipse cx="36" cy="35" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(8 36 35)" />
      <ellipse cx="42" cy="34" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(12 42 34)" />
      <ellipse cx="25" cy="42" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(-5 25 42)" />
      <ellipse cx="32" cy="41" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(3 32 41)" />
      <ellipse cx="39" cy="41" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(10 39 41)" />
      <ellipse cx="28" cy="48" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(-2 28 48)" />
      <ellipse cx="35" cy="48" rx="1.2" ry="1.6" fill="#f9a825" transform="rotate(5 35 48)" />
      {/* Gradient definition */}
      <defs>
        <radialGradient id="berry-gradient" cx="35%" cy="30%" r="65%">
          <stop offset="0%" stopColor="#ff5252" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#b71c1c" stopOpacity="0.3" />
        </radialGradient>
      </defs>
    </svg>
  );
}
