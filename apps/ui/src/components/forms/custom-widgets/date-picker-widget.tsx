import * as React from 'react';
import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import type { WidgetProps } from '@rjsf/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function DatePickerWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  rawErrors,
}: WidgetProps) {
  const [open, setOpen] = React.useState(false);
  const dateValue = value ? new Date(value as string) : undefined;

  // The RJSF field template already renders the field label (and required
  // asterisk); rendering our own <Label> here double-labelled every date
  // field. Rely on the field template's label, like the other widgets.
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            disabled={disabled || readonly}
            className={cn(
              'w-full justify-start text-left font-normal',
              !dateValue && 'text-muted-foreground',
              rawErrors && rawErrors.length > 0 && 'border-destructive'
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {dateValue ? format(dateValue, 'PPP') : 'Pick a date'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={dateValue}
            onSelect={(date: Date | undefined) => {
              if (date) {
                onChange(format(date, 'yyyy-MM-dd'));
              }
              setOpen(false);
            }}
            disabled={disabled || readonly}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
