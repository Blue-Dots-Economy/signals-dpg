import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getDomainIcon, formatDomainLabel } from '@/lib/domain-icons';
import { getActionDisplay } from '@/lib/action-display';

interface ActionModalHeaderProps {
  actionKey: string;
  title: string;
  description?: string;
  fromDomain?: string;
  toDomain?: string;
  className?: string;
}

// Branded header band for action modals (Connect / Accept / Reject / Cancel / Complete).
// Shows action icon + title in a colored gradient strip, with a role-flow badge
// underneath (from domain → to domain, with role icons).
export function ActionModalHeader({
  actionKey,
  title,
  description,
  fromDomain,
  toDomain,
  className,
}: ActionModalHeaderProps) {
  const display = getActionDisplay(actionKey);
  const Icon = display.icon;
  const FromIcon = getDomainIcon(fromDomain);
  const ToIcon = getDomainIcon(toDomain);

  return (
    <div
      className={cn(
        'relative -mx-6 -mt-6 mb-2 overflow-hidden rounded-t-lg bg-gradient-to-br px-6 py-5',
        display.gradient,
        className
      )}
    >
      {/* Subtle texture for visual depth */}
      <div
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.3) 0%, transparent 40%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.2) 0%, transparent 40%)',
        }}
      />

      <div className="relative z-10">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm ring-1 ring-white/30">
            <Icon className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-white leading-tight">{title}</h2>
            {description && (
              <p className={cn('mt-0.5 text-xs leading-snug text-white/75')}>{description}</p>
            )}
          </div>
        </div>

        {(fromDomain || toDomain) && (
          <div className="mt-4 flex items-center gap-2">
            {fromDomain && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-sm ring-1 ring-white/20">
                <FromIcon className="h-3.5 w-3.5 text-white" />
                <span className="text-xs font-semibold text-white">{formatDomainLabel(fromDomain)}</span>
              </span>
            )}
            {fromDomain && toDomain && (
              <ArrowRight className="h-3.5 w-3.5 text-white/60" />
            )}
            {toDomain && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-sm ring-1 ring-white/20">
                <ToIcon className="h-3.5 w-3.5 text-white" />
                <span className="text-xs font-semibold text-white">{formatDomainLabel(toDomain)}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
