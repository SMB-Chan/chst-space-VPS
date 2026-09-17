type IconProps = {
  className?: string;
  strokeWidth?: number;
};

/** Compact GitHub mark (lucide dropped brand icons). */
export function GithubMark({ className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.9a3.4 3.4 0 0 0-1-2.6c3.2-.3 6.5-1.6 6.5-7.1A5.4 5.4 0 0 0 18 2.8 5 5 0 0 0 17.9 0S16.7-.4 14 1.5a13.4 13.4 0 0 0-6 0C5.3-.4 4.1 0 4.1 0A5 5 0 0 0 4 2.8 5.4 5.4 0 0 0 2.5 5.4c0 5.4 3.3 6.8 6.4 7.1a3.4 3.4 0 0 0-.9 2.6V22" />
    </svg>
  );
}
