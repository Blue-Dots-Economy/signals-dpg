import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pencil, Pause, Play, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { setItemLifecycle, type Item } from '@/lib/item-api';

export interface ProfileRowActionsProps {
  profile: Item;
  /** Whether the network allows pausing (network.pause_enabled, default true). */
  pauseEnabled: boolean;
  /** Open the profile editor. */
  onEdit: () => void;
  /** Called after a lifecycle change so the owner's list refreshes. */
  onChanged: () => void;
}

/**
 * Icon-only per-profile lifecycle actions shown on each "My Profiles" row
 * (#346 pause / #347 retire): Edit · Pause/Resume · Retire. Pause + retire are
 * confirmed first (retire is terminal + irreversible); resume is applied
 * directly. Lives here — the row — not inside the edit form.
 */
export function ProfileRowActions({ profile, pauseEnabled, onEdit, onChanged }: ProfileRowActionsProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState(false);
  const [pauseConfirm, setPauseConfirm] = React.useState(false);
  const [resumeConfirm, setResumeConfirm] = React.useState(false);
  const [retireConfirm, setRetireConfirm] = React.useState(false);

  const status = profile.lifecycle_status;
  // Pause offered only on a live profile when the network allows it; resume on a
  // paused one (always allowed, so a paused profile can be recovered).
  const showPause = status === 'live' && pauseEnabled;
  const showResume = status === 'paused';

  const run = async (action: 'pause' | 'unpause' | 'retire') => {
    setBusy(true);
    try {
      const res = await setItemLifecycle(profile.item_id, action);
      toast.success(
        action === 'retire'
          ? t('profile.toast_retired', 'Profile retired — it has been permanently removed from the network.')
          : action === 'pause'
            ? t('profile.toast_paused', 'Profile paused — it is no longer discoverable in the network.')
            : res.lifecycle_status === 'live'
              ? t('profile.toast_unpaused_live', 'Profile resumed — discoverable in the network again.')
              : t('profile.toast_unpaused_draft', 'Profile resumed, but it needs completing before it goes live.'),
      );
      onChanged();
    } catch {
      toast.error(t('profile.toast_lifecycle_failed', 'Could not update profile status. Try again.'));
    } finally {
      setBusy(false);
      setPauseConfirm(false);
      setResumeConfirm(false);
      setRetireConfirm(false);
    }
  };

  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-40';

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('profile.btn_edit', 'Edit profile')}
            className={iconBtn}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('profile.btn_edit', 'Edit profile')}</TooltipContent>
      </Tooltip>

      {showPause && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('profile.btn_pause', 'Pause profile')}
              className={iconBtn}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); setPauseConfirm(true); }}
            >
              <Pause className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('profile.btn_pause', 'Pause profile')}</TooltipContent>
        </Tooltip>
      )}

      {showResume && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('profile.btn_unpause', 'Resume profile')}
              className={iconBtn}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); setResumeConfirm(true); }}
            >
              <Play className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('profile.btn_unpause', 'Resume profile')}</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('profile.btn_retire', 'Retire profile')}
            className={`${iconBtn} hover:text-destructive`}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); setRetireConfirm(true); }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('profile.btn_retire', 'Retire profile')}</TooltipContent>
      </Tooltip>

      {/* Confirm before pausing — pausing removes the profile from discovery. */}
      <Dialog open={pauseConfirm} onOpenChange={setPauseConfirm}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t('profile.pause_confirm_title', 'Pause this profile?')}</DialogTitle>
            <DialogDescription>
              {t('profile.pause_confirm_desc', 'While paused:')}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('profile.pause_effect_discovery', 'It is hidden — not discoverable by anyone in the network.')}</li>
            <li>{t('profile.pause_effect_actions', 'New connections or requests cannot be started, and any in-progress ones pause until you resume.')}</li>
            <li>{t('profile.pause_effect_kept', 'Nothing is deleted — existing connections stay, but your contact details are hidden while paused.')}</li>
            <li>{t('profile.pause_effect_recoverable', 'You can resume any time — the profile goes live and everything is restored.')}</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPauseConfirm(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button disabled={busy} onClick={() => { void run('pause'); }}>
              {t('profile.pause_confirm_proceed', 'Pause profile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before resuming — explain it becomes discoverable again (and may
          land as a draft if still incomplete). */}
      <Dialog open={resumeConfirm} onOpenChange={setResumeConfirm}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t('profile.resume_confirm_title', 'Resume this profile?')}</DialogTitle>
            <DialogDescription>
              {t('profile.resume_confirm_desc', 'When you resume:')}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('profile.resume_effect_discovery', 'It becomes discoverable in the network again.')}</li>
            <li>{t('profile.resume_effect_actions', 'You can send and receive connections and actions on it again.')}</li>
            <li>{t('profile.resume_effect_draft', 'If any required details are still missing, it stays a draft until you complete them.')}</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setResumeConfirm(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              className="bg-brand-cta text-white hover:brightness-110"
              disabled={busy}
              onClick={() => { void run('unpause'); }}
            >
              {t('profile.resume_confirm_proceed', 'Resume profile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before retiring — terminal, irreversible, wipes PII (#347). */}
      <Dialog open={retireConfirm} onOpenChange={setRetireConfirm}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{t('profile.retire_confirm_title', 'Retire this profile?')}</DialogTitle>
            <DialogDescription>
              {t('profile.retire_confirm_desc', 'When you retire this profile:')}
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('profile.retire_effect_removed', "It's permanently removed and taken out of the network — no longer discoverable.")}</li>
            <li>{t('profile.retire_effect_actions', 'Any open connections or requests on it are cancelled.')}</li>
            <li>{t('profile.retire_effect_irreversible', 'This cannot be undone — the profile cannot be restored.')}</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRetireConfirm(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => { void run('retire'); }}>
              {t('profile.retire_confirm_proceed', 'Retire permanently')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
