import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';

interface ContentHeaderProps {
  title: string;
  description?: string;
  count?: number;
  noProfilePrompt?: { show: boolean; networkId: string };
}

export function ContentHeader({ title, description, count, noProfilePrompt }: ContentHeaderProps) {
  return (
    <div className="mb-6 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {count !== undefined && count > 0 && (
              <span className="shrink-0 rounded-full bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 leading-none">
                {count} {count === 1 ? 'listing' : 'listings'}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {noProfilePrompt?.show && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-primary/15 bg-primary/5 px-4 py-3">
          <p className="text-sm text-foreground/80">
            You&apos;re browsing as a visitor. Create a profile to connect with others.
          </p>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="shrink-0 border-primary/30 text-primary hover:bg-primary/10"
          >
            <Link to={`/profile/new?network=${noProfilePrompt.networkId}`}>
              <UserPlus className="h-3.5 w-3.5 mr-1.5" />
              Create profile
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
