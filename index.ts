import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? true;
const guestbookNamespaceName = config.get("guestbookNamespace") ?? "guestbook";
const monitoringNamespaceName = config.get("monitoringNamespace") ?? "monitoring";
const grafanaServiceType = isMinikube ? "NodePort" : "LoadBalancer";
const grafanaAdminUser = "admin";
const grafanaAdminPassword = config.getSecret("grafanaAdminPassword") ?? pulumi.secret("admin");

const guestbookNamespace = new k8s.core.v1.Namespace("guestbook-namespace", {
  metadata: { name: guestbookNamespaceName },
});

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring-namespace", {
  metadata: { name: monitoringNamespaceName },
});

const monitorLabels = { release: "monitoring" };

const dashboard = {
  title: "Guestbook Overview",
  uid: "guestbook-overview",
  schemaVersion: 39,
  version: 1,
  refresh: "30s",
  time: { from: "now-1h", to: "now" },
  tags: ["guestbook", "pulumi"],
  panels: [
    {
      id: 1,
      title: "Frontend HTTP probe",
      type: "stat",
      gridPos: { h: 6, w: 8, x: 0, y: 0 },
      targets: [
        {
          expr: 'probe_success{job="guestbook-frontend"}',
          legendFormat: "success",
        },
      ],
    },
    {
      id: 2,
      title: "Guestbook pod CPU",
      type: "timeseries",
      gridPos: { h: 8, w: 16, x: 8, y: 0 },
      targets: [
        {
          expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${guestbookNamespaceName}",container!="",pod!=""}[5m]))`,
          legendFormat: "{{pod}}",
        },
      ],
    },
    {
      id: 3,
      title: "Guestbook pod memory",
      type: "timeseries",
      gridPos: { h: 8, w: 12, x: 0, y: 8 },
      targets: [
        {
          expr: `sum by (pod) (container_memory_working_set_bytes{namespace="${guestbookNamespaceName}",container!="",pod!=""})`,
          legendFormat: "{{pod}}",
        },
      ],
    },
    {
      id: 4,
      title: "Redis connected clients",
      type: "timeseries",
      gridPos: { h: 8, w: 12, x: 12, y: 8 },
      targets: [
        {
          expr: `redis_connected_clients{namespace="${guestbookNamespaceName}"}`,
          legendFormat: "{{service}}",
        },
      ],
    },
  ],
};

new k8s.core.v1.ConfigMap("guestbook-dashboard", {
  metadata: {
    name: "guestbook-dashboard",
    namespace: monitoringNamespace.metadata.name,
    labels: { grafana_dashboard: "1" },
  },
  data: {
    "guestbook-overview.json": JSON.stringify(dashboard),
  },
}, { dependsOn: monitoringNamespace });

const monitoringStack = new k8s.helm.v3.Release("monitoring", {
  namespace: monitoringNamespace.metadata.name,
  chart: "kube-prometheus-stack",
  version: "86.1.0",
  repositoryOpts: {
    repo: "https://prometheus-community.github.io/helm-charts",
  },
  values: {
    grafana: {
      adminUser: grafanaAdminUser,
      adminPassword: grafanaAdminPassword,
      service: {
        type: grafanaServiceType,
      },
      sidecar: {
        dashboards: {
          enabled: true,
          label: "grafana_dashboard",
          searchNamespace: "ALL",
        },
      },
    },
    prometheus: {
      prometheusSpec: {
        serviceMonitorSelectorNilUsesHelmValues: false,
        serviceMonitorNamespaceSelector: {},
        podMonitorSelectorNilUsesHelmValues: false,
        podMonitorNamespaceSelector: {},
        probeSelectorNilUsesHelmValues: false,
        probeNamespaceSelector: {},
        ruleSelectorNilUsesHelmValues: false,
      },
    },
  },
}, { dependsOn: monitoringNamespace });

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
  metadata: {
    namespace: guestbookNamespace.metadata.name,
    labels: redisLeaderLabels,
  },
  spec: {
    selector: { matchLabels: redisLeaderLabels },
    template: {
      metadata: { labels: redisLeaderLabels },
      spec: {
        containers: [
          {
            name: "redis-leader",
            image: "redis",
            resources: { requests: { cpu: "100m", memory: "100Mi" } },
            ports: [{ name: "redis", containerPort: 6379 }],
          },
          {
            name: "redis-exporter",
            image: "oliver006/redis_exporter:v1.62.0",
            env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
            ports: [{ name: "metrics", containerPort: 9121 }],
          },
        ],
      },
    },
  },
}, { dependsOn: guestbookNamespace });

const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
  metadata: {
    name: "redis-leader",
    namespace: guestbookNamespace.metadata.name,
    labels: redisLeaderLabels,
  },
  spec: {
    ports: [
      { name: "redis", port: 6379, targetPort: "redis" },
      { name: "metrics", port: 9121, targetPort: "metrics" },
    ],
    selector: redisLeaderLabels,
  },
}, { dependsOn: redisLeaderDeployment });

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
  metadata: {
    namespace: guestbookNamespace.metadata.name,
    labels: redisReplicaLabels,
  },
  spec: {
    selector: { matchLabels: redisReplicaLabels },
    template: {
      metadata: { labels: redisReplicaLabels },
      spec: {
        containers: [
          {
            name: "replica",
            image: "pulumi/guestbook-redis-replica",
            resources: { requests: { cpu: "100m", memory: "100Mi" } },
            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
            ports: [{ name: "redis", containerPort: 6379 }],
          },
          {
            name: "redis-exporter",
            image: "oliver006/redis_exporter:v1.62.0",
            env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
            ports: [{ name: "metrics", containerPort: 9121 }],
          },
        ],
      },
    },
  },
}, { dependsOn: redisLeaderService });

const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
  metadata: {
    name: "redis-replica",
    namespace: guestbookNamespace.metadata.name,
    labels: redisReplicaLabels,
  },
  spec: {
    ports: [
      { name: "redis", port: 6379, targetPort: "redis" },
      { name: "metrics", port: 9121, targetPort: "metrics" },
    ],
    selector: redisReplicaLabels,
  },
}, { dependsOn: redisReplicaDeployment });

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
  metadata: {
    namespace: guestbookNamespace.metadata.name,
    labels: frontendLabels,
  },
  spec: {
    selector: { matchLabels: frontendLabels },
    replicas: 3,
    template: {
      metadata: { labels: frontendLabels },
      spec: {
        containers: [
          {
            name: "frontend",
            image: "pulumi/guestbook-php-redis",
            resources: { requests: { cpu: "100m", memory: "100Mi" } },
            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
            ports: [{ name: "http", containerPort: 80 }],
          },
        ],
      },
    },
  },
}, { dependsOn: redisReplicaService });

const frontendService = new k8s.core.v1.Service("frontend", {
  metadata: {
    name: "frontend",
    namespace: guestbookNamespace.metadata.name,
    labels: frontendLabels,
  },
  spec: {
    type: isMinikube ? "NodePort" : "LoadBalancer",
    ports: [{ name: "http", port: 80, targetPort: "http" }],
    selector: frontendLabels,
  },
}, { dependsOn: frontendDeployment });

const blackboxConfig = new k8s.core.v1.ConfigMap("blackbox-exporter-config", {
  metadata: {
    name: "blackbox-exporter-config",
    namespace: monitoringNamespace.metadata.name,
  },
  data: {
    "blackbox.yml": JSON.stringify({
      modules: {
        http_2xx: {
          prober: "http",
          timeout: "5s",
          http: {
            valid_http_versions: ["HTTP/1.1", "HTTP/2.0"],
            valid_status_codes: [],
            method: "GET",
            preferred_ip_protocol: "ip4",
          },
        },
      },
    }),
  },
}, { dependsOn: monitoringNamespace });

const blackboxLabels = { app: "blackbox-exporter" };
const blackboxDeployment = new k8s.apps.v1.Deployment("blackbox-exporter", {
  metadata: {
    namespace: monitoringNamespace.metadata.name,
    labels: blackboxLabels,
  },
  spec: {
    selector: { matchLabels: blackboxLabels },
    replicas: 1,
    template: {
      metadata: { labels: blackboxLabels },
      spec: {
        containers: [
          {
            name: "blackbox-exporter",
            image: "prom/blackbox-exporter:v0.25.0",
            args: ["--config.file=/etc/blackbox_exporter/blackbox.yml"],
            ports: [{ name: "http", containerPort: 9115 }],
            volumeMounts: [
              {
                name: "config",
                mountPath: "/etc/blackbox_exporter",
              },
            ],
          },
        ],
        volumes: [
          {
            name: "config",
            configMap: { name: blackboxConfig.metadata.name },
          },
        ],
      },
    },
  },
}, { dependsOn: [blackboxConfig, monitoringStack] });

const blackboxService = new k8s.core.v1.Service("blackbox-exporter", {
  metadata: {
    name: "blackbox-exporter",
    namespace: monitoringNamespace.metadata.name,
    labels: blackboxLabels,
  },
  spec: {
    ports: [{ name: "http", port: 9115, targetPort: "http" }],
    selector: blackboxLabels,
  },
}, { dependsOn: blackboxDeployment });

function serviceMonitor(resourceName: string, metadataName: string, appLabel: string) {
  return new k8s.apiextensions.CustomResource(resourceName, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
      name: metadataName,
      namespace: monitoringNamespace.metadata.name,
      labels: monitorLabels,
    },
    spec: {
      namespaceSelector: { matchNames: [guestbookNamespace.metadata.name] },
      selector: { matchLabels: { app: appLabel } },
      endpoints: [
        {
          port: "metrics",
          path: "/metrics",
          interval: "15s",
        },
      ],
    },
  }, { dependsOn: monitoringStack });
}

serviceMonitor("redis-leader-servicemonitor", "redis-leader", "redis-leader");
serviceMonitor("redis-replica-servicemonitor", "redis-replica", "redis-replica");

new k8s.apiextensions.CustomResource("guestbook-frontend-probe", {
  apiVersion: "monitoring.coreos.com/v1",
  kind: "Probe",
  metadata: {
    name: "guestbook-frontend",
    namespace: monitoringNamespace.metadata.name,
    labels: monitorLabels,
  },
  spec: {
    jobName: "guestbook-frontend",
    prober: {
      url: pulumi.interpolate`${blackboxService.metadata.name}.${monitoringNamespace.metadata.name}.svc.cluster.local:9115`,
    },
    module: "http_2xx",
    targets: {
      staticConfig: {
        static: [
          pulumi.interpolate`http://${frontendService.metadata.name}.${guestbookNamespace.metadata.name}.svc.cluster.local`,
        ],
      },
    },
  },
}, { dependsOn: [monitoringStack, blackboxService, frontendService] });

const grafanaService = k8s.core.v1.Service.get("grafana-service",
  pulumi.interpolate`${monitoringNamespace.metadata.name}/monitoring-grafana`,
  { dependsOn: monitoringStack });

export const frontendServiceName = frontendService.metadata.name;
export const frontendNamespace = guestbookNamespace.metadata.name;
export const frontendUrl = isMinikube
  ? "http://localhost:8080"
  : frontendService.status.loadBalancer.ingress.apply(ingress =>
    `http://${ingress[0].hostname ?? ingress[0].ip}`);
export const frontendPortForwardCommand = pulumi.interpolate`kubectl -n ${guestbookNamespace.metadata.name} port-forward svc/${frontendService.metadata.name} 8080:80`;
export const grafanaServiceName = grafanaService.metadata.name;
export const grafanaNamespace = monitoringNamespace.metadata.name;
export const grafanaUrl = isMinikube
  ? "http://localhost:3000"
  : grafanaService.status.loadBalancer.ingress.apply(ingress =>
    `http://${ingress[0].hostname ?? ingress[0].ip}`);
export const grafanaPortForwardCommand = pulumi.interpolate`kubectl -n ${monitoringNamespace.metadata.name} port-forward svc/${grafanaService.metadata.name} 3000:80`;
export const grafanaUsername = grafanaAdminUser;
export const grafanaPassword = grafanaAdminPassword;
export const prometheusVerification = pulumi.interpolate`kubectl -n ${monitoringNamespace.metadata.name} port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090`;
