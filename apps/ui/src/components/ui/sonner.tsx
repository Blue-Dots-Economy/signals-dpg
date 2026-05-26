import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      expand={false}
      icons={{
        success: <CircleCheckIcon className="size-5" />,
        info: <InfoIcon className="size-5" />,
        warning: <TriangleAlertIcon className="size-5" />,
        error: <OctagonXIcon className="size-5" />,
        loading: <Loader2Icon className="size-5 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Success — rich green
          "--success-bg":     "oklch(0.96 0.05 145)",
          "--success-border": "oklch(0.80 0.12 145)",
          "--success-text":   "oklch(0.28 0.10 145)",
          // Error — clear red
          "--error-bg":     "oklch(0.96 0.04 25)",
          "--error-border": "oklch(0.75 0.14 25)",
          "--error-text":   "oklch(0.28 0.12 25)",
          // Info — neutral indigo
          "--info-bg":     "oklch(0.95 0.03 260)",
          "--info-border": "oklch(0.75 0.10 260)",
          "--info-text":   "oklch(0.28 0.10 260)",
          // Width — wide enough to feel substantial
          "--width": "360px",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
