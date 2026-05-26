import type { LucideIcon } from 'lucide-react';

interface RoleCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export function RoleCard({ icon: Icon, title, description, onClick, variant = 'primary' }: RoleCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group relative flex flex-col rounded-xl border p-5 text-left transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        '@media (prefers-reduced-motion: no-preference) { hover:-translate-y-0.5 }',
        variant === 'primary'
          ? 'border-border bg-gradient-to-br from-primary/5 to-background hover:border-primary/40 hover:shadow-md'
          : 'border-border bg-gradient-to-br from-accent/30 to-background hover:border-primary/30 hover:shadow-sm',
      ].join(' ')}
    >
      {/* Icon tile */}
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/15">
        <Icon className="h-5 w-5 text-primary" />
      </div>

      {/* Text */}
      <p className="mb-1 font-semibold text-foreground leading-tight">{title}</p>
      <p className="text-sm text-muted-foreground leading-snug">{description}</p>
    </button>
  );
}
