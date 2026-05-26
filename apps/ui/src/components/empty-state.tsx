interface EmptyStateProps {
  heading?: string;
  message?: string;
  action?: React.ReactNode;
}

function SparseDots() {
  return (
    <svg
      viewBox="0 0 200 120"
      xmlns="http://www.w3.org/2000/svg"
      className="w-32 h-20 opacity-25"
      aria-hidden="true"
    >
      <g stroke="var(--brand-hero-glow)" strokeWidth="0.8" strokeOpacity="0.6" fill="none">
        <line x1="40" y1="60" x2="100" y2="30" />
        <line x1="100" y1="30" x2="160" y2="60" />
        <line x1="40" y1="60" x2="100" y2="90" />
        <line x1="100" y1="90" x2="160" y2="60" />
        <line x1="100" y1="30" x2="100" y2="90" />
      </g>
      <g fill="var(--brand-hero-glow)" fillOpacity="0.7">
        <circle cx="40" cy="60" r="4" />
        <circle cx="100" cy="30" r="5" />
        <circle cx="160" cy="60" r="4" />
        <circle cx="100" cy="90" r="3.5" />
        <circle cx="70" cy="45" r="2.5" />
        <circle cx="130" cy="75" r="2" />
      </g>
    </svg>
  );
}

export function EmptyState({ heading, message = 'No items found', action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <SparseDots />
      {heading && <p className="font-semibold text-foreground">{heading}</p>}
      <p className="text-muted-foreground text-sm max-w-xs">{message}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
