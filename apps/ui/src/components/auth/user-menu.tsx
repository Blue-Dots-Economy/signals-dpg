import { useAuth } from '@/contexts/auth-context';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';

export function UserMenu() {
  const { user, signOut } = useAuth();

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success('Signed out', {
        description: 'You\'ve been signed out safely. Sign back in whenever you\'re ready.',
      });
    } catch {
      toast.error('Couldn\'t sign out', {
        description: 'Something went wrong. Please try again — if the problem persists, refresh the page.',
      });
    }
  };

  if (!user) return null;

  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return parts.map((n) => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const initials = getInitials(user.name);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-primary"
        >
          {user.image ? (
            <img
              src={user.image}
              alt={user.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs font-medium text-primary-foreground">
              {initials}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="z-[1000] w-64 p-0" align="end" sideOffset={8}>
        <div className="flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
            {initials}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{user.name}</span>
            {user.email && (
              <span className="text-xs text-muted-foreground">
                {user.email}
              </span>
            )}
          </div>
        </div>
        <div className="border-t p-1">
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
