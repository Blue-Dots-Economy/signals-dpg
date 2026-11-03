/** Red message under a hand-built field; pair the control with `fieldErrorAria`. */
export function InlineFieldError({ id, message }: Readonly<{ id: string; message?: string | null }>) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** `aria-invalid` + `aria-describedby` for a control whose error renders as `<InlineFieldError id={errorId}>`. */
export function fieldErrorAria(errorId: string, message?: string | null) {
  return message ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
}
