import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/auth-context';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LogOut, LifeBuoy, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { SupportDialog } from '@/components/support/support-dialog';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import { usePendingActionsCount } from '@/hooks/use-actions';

export function UserMenu() {
  const { user, signOut } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [supportOpen, setSupportOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const { data: pendingCount = 0 } = usePendingActionsCount();

  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success(t('menu.toast_signed_out'), {
        description: t('menu.toast_signed_out_desc'),
      });
    } catch {
      toast.error(t('menu.toast_sign_out_error'), {
        description: t('menu.toast_sign_out_error_desc'),
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

  const handleNotificationsClick = () => {
    setPopoverOpen(false);
    navigate('/my-actions');
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-primary"
            aria-label={
              pendingCount > 0
                ? t('nav.pending_actions', { count: pendingCount })
                : undefined
            }
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
            {pendingCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background md:hidden" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="end">
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
          {/* Mobile-only: Notifications, Language and Theme normally live
              inline in the top bar, but are hidden there below `md` to keep
              the bar from overflowing — they're reachable here instead. */}
          <div className="border-t p-1 md:hidden">
            <button
              type="button"
              onClick={handleNotificationsClick}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent"
            >
              <Bell className="h-4 w-4" />
              {t('menu.notifications')}
              {pendingCount > 0 && (
                <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {pendingCount > 9 ? '9+' : pendingCount}
                </span>
              )}
            </button>
            <div className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{t('language.label')}</span>
              <LanguageSwitcher compact />
            </div>
            <div className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{t('menu.theme')}</span>
              <ThemeModeToggle />
            </div>
          </div>
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => setSupportOpen(true)}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent"
            >
              <LifeBuoy className="h-4 w-4" />
              {t('menu.contact_support')}
            </button>
          </div>
          <div className="border-t p-1">
            <button
              onClick={handleSignOut}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              {t('menu.sign_out')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
    </>
  );
}
