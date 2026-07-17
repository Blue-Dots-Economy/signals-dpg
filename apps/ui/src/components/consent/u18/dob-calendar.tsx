import * as React from 'react';
import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface DobCalendarProps {
  value?: Date;
  onChange: (date: Date) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}

/**
 * Date-of-birth calendar picker (U18). The full date is persisted server-side
 * on `user.date_of_birth` (submitU18Dob). Future dates are blocked; year
 * navigation uses a dropdown caption for quick back-navigation.
 */
export function DobCalendar({
  value,
  onChange,
  disabled,
  id,
  placeholder = 'Select date of birth',
}: DobCalendarProps) {
  const [open, setOpen] = React.useState(false);
  const today = new Date();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'h-11 w-full justify-start text-left font-normal',
            !value && 'text-muted-foreground',
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? format(value, 'PPP') : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value ?? today}
          captionLayout="dropdown"
          startMonth={new Date(1940, 0)}
          endMonth={today}
          disabled={{ after: today }}
          onSelect={(date: Date | undefined) => {
            if (date) {
              onChange(date);
              setOpen(false);
            }
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
