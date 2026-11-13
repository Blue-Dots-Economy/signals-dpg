import * as React from 'react';
import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import { errorId, type WidgetProps } from '@rjsf/utils';
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
  onBlur,
  rawErrors,
}: WidgetProps) {
  const [open, setOpen] = React.useState(false);
  const invalid = Boolean(rawErrors && rawErrors.length > 0);
  const dateValue = value ? new Date(value as string) : undefined;

  // No <Label>: the field template already renders it.
  return (
    <div className="space-y-2">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onBlur(id, value);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            disabled={disabled || readonly}
            {...(invalid ? { 'aria-invalid': true, 'aria-describedby': errorId(id) } : {})}
            className={cn(
              'w-full justify-start text-left font-normal',
              !dateValue && 'text-muted-foreground',
              invalid && 'border-destructive'
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
              onBlur(id, value);
            }}
            disabled={disabled || readonly}
            autoFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
