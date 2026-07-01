import { useState } from 'react';
import type { ConsentConfigDocument } from '@dpg/schemas';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Markdown } from '@/components/consent/markdown';

export type ConsentModalMode = 'gate' | 'view';
export type ConsentModalTab = 'privacy' | 'terms';

export interface ConsentModalProps {
  open: boolean;
  mode: ConsentModalMode;
  initialTab: ConsentModalTab;
  config: ConsentConfigDocument;
  onAccept?: () => void;
  onOpenChange?: (open: boolean) => void;
}

function getCurrentVersion(doc: ConsentConfigDocument['documents']['terms'] | ConsentConfigDocument['documents']['privacy']) {
  return doc.versions.find((v) => v.version === doc.current_version);
}

export function ConsentModal({
  open,
  mode,
  initialTab,
  config,
  onAccept,
  onOpenChange,
}: ConsentModalProps) {
  const [checked, setChecked] = useState(false);

  const privacyVersion = getCurrentVersion(config.documents.privacy);
  const termsVersion = getCurrentVersion(config.documents.terms);

  const handleOpenChange = (nextOpen: boolean) => {
    if (mode === 'gate') return;
    onOpenChange?.(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={mode === 'view'}
        className="flex flex-col max-w-2xl max-h-[90vh] gap-0 p-0 overflow-hidden"
        onInteractOutside={(e) => {
          if (mode === 'gate') e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (mode === 'gate') e.preventDefault();
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="text-lg font-semibold">
            {mode === 'gate' ? 'Review & accept to continue' : 'Privacy Policy & Terms'}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {mode === 'gate'
              ? 'Please read the following documents and accept to proceed.'
              : 'Read the documents below.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col flex-1 overflow-hidden px-6 pb-4 gap-4">
          <Tabs defaultValue={initialTab} className="flex flex-col flex-1 overflow-hidden">
            <TabsList className="w-full shrink-0">
              <TabsTrigger value="privacy" className="flex-1">
                Privacy Policy
              </TabsTrigger>
              <TabsTrigger value="terms" className="flex-1">
                Terms of Service
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="privacy"
              className="flex-1 overflow-y-auto mt-4 pr-1"
            >
              {privacyVersion && (
                <>
                  <h3 className="text-base font-semibold mb-3">{privacyVersion.title}</h3>
                  <Markdown>{privacyVersion.content}</Markdown>
                </>
              )}
            </TabsContent>

            <TabsContent
              value="terms"
              className="flex-1 overflow-y-auto mt-4 pr-1"
            >
              {termsVersion && (
                <>
                  <h3 className="text-base font-semibold mb-3">{termsVersion.title}</h3>
                  <Markdown>{termsVersion.content}</Markdown>
                </>
              )}
            </TabsContent>
          </Tabs>

          {mode === 'gate' && (
            <div className="shrink-0 pt-4 border-t border-border flex flex-col gap-3">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="consent-agree"
                  checked={checked}
                  onCheckedChange={(value) => setChecked(value === true)}
                />
                <Label htmlFor="consent-agree" className="text-sm leading-snug cursor-pointer">
                  I have read and agree to the Terms of Service and Privacy Policy.
                </Label>
              </div>
              <button
                type="button"
                disabled={!checked}
                onClick={onAccept}
                className="flex w-full items-center justify-center rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta hover:brightness-110 h-11"
              >
                Accept
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
