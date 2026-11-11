import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*5)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 [&>svg]:row-start-1 [&>svg]:col-start-1 [&>svg]:self-start [&>svg]:mt-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default:
          "bg-card text-card-foreground border-border",
        success:
          "border-[oklch(0.80_0.12_145)] bg-[oklch(0.96_0.05_145)] text-[oklch(0.28_0.10_145)] [&>svg]:text-[oklch(0.48_0.15_145)]",
        destructive:
          "border-destructive/40 bg-destructive/8 text-destructive [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 row-start-1 font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 row-start-2 text-sm opacity-90 [&_p]:leading-relaxed", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
