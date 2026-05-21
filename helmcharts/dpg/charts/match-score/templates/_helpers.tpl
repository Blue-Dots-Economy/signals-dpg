{{/*
Expand the name of the chart.
*/}}
{{- define "dpg-match-score.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "dpg-match-score.fullname" -}}
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
{{- define "dpg-match-score.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "dpg-match-score.labels" -}}
helm.sh/chart: {{ include "dpg-match-score.chart" . }}
{{ include "dpg-match-score.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "dpg-match-score.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dpg-match-score.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "dpg-match-score.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dpg-match-score.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
envFrom Secret name (REDIS_PASSWORD).
*/}}
{{- define "dpg-match-score.secretName" -}}
{{- if and (not .Values.secrets.create) .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "dpg-match-score.fullname" . }}
{{- end }}
{{- end }}

{{/*
configFiles Secret name (mounted JSON files).
*/}}
{{- define "dpg-match-score.configFilesName" -}}
{{- if and (not .Values.configFiles.create) .Values.configFiles.existingSecret }}
{{- .Values.configFiles.existingSecret }}
{{- else }}
{{- printf "%s-files" (include "dpg-match-score.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
