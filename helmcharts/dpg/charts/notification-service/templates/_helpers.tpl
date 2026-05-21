{{/*
Expand the name of the chart.
*/}}
{{- define "dpg-notification-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "dpg-notification-service.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label.
*/}}
{{- define "dpg-notification-service.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "dpg-notification-service.labels" -}}
helm.sh/chart: {{ include "dpg-notification-service.chart" . }}
{{ include "dpg-notification-service.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "dpg-notification-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dpg-notification-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "dpg-notification-service.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dpg-notification-service.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
envFrom Secret name.
*/}}
{{- define "dpg-notification-service.secretName" -}}
{{- if and (not .Values.secrets.create) .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "dpg-notification-service.fullname" . }}
{{- end }}
{{- end }}

{{/*
Internal-secrets-json Secret name (mounted file, not envFrom).
*/}}
{{- define "dpg-notification-service.internalSecretsName" -}}
{{- if and (not .Values.internalSecrets.create) .Values.internalSecrets.existingSecret }}
{{- .Values.internalSecrets.existingSecret }}
{{- else }}
{{- printf "%s-internal" (include "dpg-notification-service.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
