export function NetworkConstellation({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 600 500"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        {/* Radial glow halos — recolored via CSS var */}
        <radialGradient id="glow-a" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--brand-hero-glow)" stopOpacity="0.6" />
          <stop offset="100%" stopColor="var(--brand-hero-glow)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="glow-b" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--brand-hero-glow)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--brand-hero-glow)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Halo circles behind key dots */}
      <circle cx="120" cy="90" r="40" fill="url(#glow-a)" />
      <circle cx="480" cy="200" r="50" fill="url(#glow-b)" />
      <circle cx="300" cy="380" r="36" fill="url(#glow-a)" />
      <circle cx="60" cy="310" r="30" fill="url(#glow-b)" />
      <circle cx="540" cy="60" r="28" fill="url(#glow-b)" />

      {/* Connection lines */}
      <g stroke="var(--brand-hero-glow)" strokeWidth="0.8" strokeOpacity="0.35" fill="none">
        <line x1="120" y1="90" x2="220" y2="160" />
        <line x1="220" y1="160" x2="300" y2="110" />
        <line x1="300" y1="110" x2="420" y2="140" />
        <line x1="420" y1="140" x2="480" y2="200" />
        <line x1="480" y1="200" x2="540" y2="60" />
        <line x1="540" y1="60" x2="420" y2="140" />
        <line x1="120" y1="90" x2="60" y2="180" />
        <line x1="60" y1="180" x2="60" y2="310" />
        <line x1="60" y1="310" x2="140" y2="380" />
        <line x1="140" y1="380" x2="300" y2="380" />
        <line x1="300" y1="380" x2="420" y2="340" />
        <line x1="420" y1="340" x2="480" y2="200" />
        <line x1="220" y1="160" x2="140" y2="260" />
        <line x1="140" y1="260" x2="60" y2="310" />
        <line x1="300" y1="110" x2="300" y2="380" />
        <line x1="140" y1="260" x2="300" y2="380" />
        <line x1="360" y1="280" x2="480" y2="200" />
        <line x1="360" y1="280" x2="300" y2="380" />
        <line x1="220" y1="160" x2="360" y2="280" />
        <line x1="420" y1="340" x2="360" y2="280" />
        <line x1="540" y1="380" x2="480" y2="200" />
        <line x1="540" y1="380" x2="420" y2="340" />
        <line x1="180" y1="440" x2="140" y2="380" />
        <line x1="180" y1="440" x2="300" y2="380" />
      </g>

      {/* Static small dots */}
      <g fill="var(--brand-hero-glow)" fillOpacity="0.55">
        <circle cx="220" cy="160" r="2.5" />
        <circle cx="300" cy="110" r="2.5" />
        <circle cx="420" cy="140" r="2.5" />
        <circle cx="60" cy="180" r="2" />
        <circle cx="140" cy="260" r="2" />
        <circle cx="140" cy="380" r="2.5" />
        <circle cx="420" cy="340" r="2.5" />
        <circle cx="360" cy="280" r="2" />
        <circle cx="540" cy="380" r="2" />
        <circle cx="180" cy="440" r="2" />
        <circle cx="500" cy="420" r="2" />
        <circle cx="80" cy="430" r="1.5" />
        <circle cx="240" cy="50" r="1.5" />
        <circle cx="450" cy="460" r="1.5" />
      </g>

      {/* Animated accent dots */}
      <circle
        className="constellation-dot-pulse"
        cx="120"
        cy="90"
        r="3"
        fill="var(--brand-hero-glow)"
        fillOpacity="0.9"
      />
      <circle
        className="constellation-dot-pulse"
        cx="480"
        cy="200"
        r="3.5"
        fill="var(--brand-hero-glow)"
        fillOpacity="0.9"
        style={{ animationDelay: '1s' }}
      />
      <circle
        className="constellation-dot-pulse"
        cx="300"
        cy="380"
        r="3"
        fill="var(--brand-hero-glow)"
        fillOpacity="0.9"
        style={{ animationDelay: '2s' }}
      />
      <circle
        className="constellation-dot-pulse-slow"
        cx="60"
        cy="310"
        r="2.5"
        fill="var(--brand-hero-glow)"
        fillOpacity="0.8"
        style={{ animationDelay: '0.5s' }}
      />
      <circle
        className="constellation-dot-pulse-slow"
        cx="540"
        cy="60"
        r="2.5"
        fill="var(--brand-hero-glow)"
        fillOpacity="0.8"
        style={{ animationDelay: '1.5s' }}
      />
    </svg>
  );
}
