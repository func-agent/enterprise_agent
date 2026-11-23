{{/* ===================================================================
  企业级 AI Agent 平台 —— 公共模板
  依据《建设方案》3.1 组件总览 / 第 9 章 部署方案与硬件配置
  =================================================================== */}}

{{- define "eap.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "eap.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "eap.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "eap.selectorLabels" -}}
app.kubernetes.io/name: {{ include "eap.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "eap.labels" -}}
helm.sh/chart: {{ include "eap.chart" . }}
{{ include "eap.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: enterprise-ai-agent-platform
{{- end -}}

{{/* 镜像地址：imageRegistry 为空时回退到 Docker Hub / ghcr.io 等原地址 */}}
{{- define "eap.image" -}}
{{- $registry := .root.Values.imageRegistry | default "" -}}
{{- $repo := .repository -}}
{{- $tag := .tag | toString -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{/* 分层 namespace（9.2：组件按层分 namespace） */}}
{{- define "eap.ns.support" -}}{{ .Values.namespaces.support }}{{- end -}}
{{- define "eap.ns.app" -}}{{ .Values.namespaces.app }}{{- end -}}
{{- define "eap.ns.data" -}}{{ .Values.namespaces.data }}{{- end -}}

{{/* 镜像拉取 Secret */}}
{{- define "eap.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{/* 通用 Pod 元数据 */}}
{{- define "eap.podLabels" -}}
{{ include "eap.labels" . }}
app.kubernetes.io/component: {{ .component | default "platform" }}
{{- end -}}

{{/* 存储类：为空时使用集群默认 */}}
{{- define "eap.storageClass" -}}
{{- $sc := .storageClass | default .root.Values.global.storageClass -}}
{{- if $sc }}
storageClassName: {{ $sc | quote }}
{{- end }}
{{- end -}}


{{/* 应用层共享存储与内网能力配置；仅在 app namespace 的 Deployment 中引用 */}}
{{- define "eap.appEnv" -}}
- name: STORE_KIND
  value: "postgres"
- name: POSTGRES_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.existingSecret | default (printf "%s-secret" (include "eap.fullname" .)) }}
      key: postgres-url
- name: CACHE_KIND
  value: "redis"
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.existingSecret | default (printf "%s-secret" (include "eap.fullname" .)) }}
      key: redis-url
- name: KEYCLOAK_ISSUER
  valueFrom:
    configMapKeyRef:
      name: {{ include "eap.fullname" . }}-platform-config
      key: KEYCLOAK_ISSUER
- name: TEI_BASE_URL
  value: {{ printf "http://%s-tei.%s.svc:%v" (include "eap.fullname" .) (include "eap.ns.data" .) .Values.knowledgeLayer.tei.service.port | quote }}
- name: INFINITY_BASE_URL
  value: {{ printf "http://%s-infinity.%s.svc:%v" (include "eap.fullname" .) (include "eap.ns.data" .) .Values.knowledgeLayer.infinity.service.httpPort | quote }}
{{- end -}}
