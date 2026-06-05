import * as fs from "fs";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? true;
const guestbookNamespaceName = config.get("guestbookNamespace") ?? "guestbook";
const monitoringNamespaceName = config.get("monitoringNamespace") ?? "monitoring";
const kubePrometheusStackVersion = config.get("kubePrometheusStackVersion") ?? "86.1.0";
const redisImage = config.get("redisImage") ?? "redis:7.4-alpine";
const redisReplicaImage = config.get("redisReplicaImage") ?? "pulumi/guestbook-redis-replica";
const frontendImage = config.get("frontendImage") ?? "pulumi/guestbook-php-redis";
const nginxImage = config.get("nginxImage") ?? "nginx:1.27-alpine";
const nginxExporterImage = config.get("nginxExporterImage") ?? "nginx/nginx-prometheus-exporter:1.3.0";
const redisExporterImage = config.get("redisExporterImage") ?? "oliver006/redis_exporter:v1.62.0";
const blackboxExporterImage = config.get("blackboxExporterImage") ?? "prom/blackbox-exporter:v0.25.0";
const grafanaServiceType = isMinikube ? "NodePort" : "LoadBalancer";
const grafanaAdminUser = "admin";
const grafanaAdminPassword = config.getSecret("grafanaAdminPassword") ?? pulumi.secret("admin");

const guestbookNamespace = new k8s.core.v1.Namespace("guestbook-namespace", {
  metadata: { name: guestbookNamespaceName },
});

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring-namespace", {
  metadata: { name: monitoringNamespaceName },
});

const guestbookQuota = new k8s.core.v1.ResourceQuota("guestbook-quota", {
  metadata: {
    name: "guestbook-quota",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    hard: {
      pods: "20",
      "requests.cpu": "2",
      "requests.memory": "2Gi",
      "limits.cpu": "6",
      "limits.memory": "8Gi",
    },
  },
}, { dependsOn: guestbookNamespace });

new k8s.core.v1.LimitRange("guestbook-limit-range", {
  metadata: {
    name: "guestbook-defaults",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    limits: [{
      type: "Container",
      defaultRequest: { cpu: "100m", memory: "128Mi" },
      default: { cpu: "500m", memory: "512Mi" },
    }],
  },
}, { dependsOn: guestbookNamespace });

new k8s.core.v1.ResourceQuota("monitoring-quota", {
  metadata: {
    name: "monitoring-quota",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    hard: {
      pods: "30",
      "requests.cpu": "4",
      "requests.memory": "6Gi",
      "limits.cpu": "10",
      "limits.memory": "16Gi",
    },
  },
}, { dependsOn: monitoringNamespace });

new k8s.core.v1.LimitRange("monitoring-limit-range", {
  metadata: {
    name: "monitoring-defaults",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    limits: [{
      type: "Container",
      defaultRequest: { cpu: "100m", memory: "128Mi" },
      default: { cpu: "1", memory: "1Gi" },
    }],
  },
}, { dependsOn: monitoringNamespace });

const monitorLabels = { release: "monitoring" };
const commonMetadataLabels = { managedBy: "pulumi" };

const frontendResources = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "512Mi" },
};
const redisResources = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "512Mi" },
};
const exporterResources = {
  requests: { cpu: "50m", memory: "64Mi" },
  limits: { cpu: "200m", memory: "256Mi" },
};

const dashboardJson = fs.readFileSync("dashboards/guestbook-overview.json", "utf8")
  .replace(/\$\{guestbookNamespace\}/g, guestbookNamespaceName);

new k8s.core.v1.ConfigMap("guestbook-dashboard", {
  metadata: {
    name: "guestbook-dashboard",
    namespace: monitoringNamespace.metadata.name,
    labels: { grafana_dashboard: "1" },
  },
  data: {
    "guestbook-overview.json": dashboardJson,
  },
}, { dependsOn: monitoringNamespace });

const monitoringStack = new k8s.helm.v3.Release("monitoring", {
  namespace: monitoringNamespace.metadata.name,
  chart: "kube-prometheus-stack",
  version: kubePrometheusStackVersion,
  timeout: 900,
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
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "500m", memory: "1Gi" },
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
        ruleNamespaceSelector: {},
        resources: {
          requests: { cpu: "250m", memory: "1Gi" },
          limits: { cpu: "1", memory: "2Gi" },
        },
      },
    },
    alertmanager: {
      alertmanagerSpec: {
        resources: {
          requests: { cpu: "50m", memory: "128Mi" },
          limits: { cpu: "250m", memory: "512Mi" },
        },
      },
    },
  },
}, { dependsOn: monitoringNamespace });

const nginxConfig = new k8s.core.v1.ConfigMap("frontend-nginx-config", {
  metadata: {
    name: "frontend-nginx-config",
    namespace: guestbookNamespace.metadata.name,
  },
  data: {
    "default.conf": `server {
  listen 8080;

  location / {
    proxy_pass http://127.0.0.1:80;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location /nginx_status {
    stub_status;
    access_log off;
  }
}
`,
  },
}, { dependsOn: guestbookNamespace });

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
  metadata: {
    namespace: guestbookNamespace.metadata.name,
    labels: { ...redisLeaderLabels, ...commonMetadataLabels },
  },
  spec: {
    selector: { matchLabels: redisLeaderLabels },
    template: {
      metadata: { labels: redisLeaderLabels },
      spec: {
        containers: [
          {
            name: "redis-leader",
            image: redisImage,
            resources: redisResources,
            ports: [{ name: "redis", containerPort: 6379 }],
            readinessProbe: { tcpSocket: { port: "redis" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { tcpSocket: { port: "redis" }, initialDelaySeconds: 15, periodSeconds: 20 },
          },
          {
            name: "redis-exporter",
            image: redisExporterImage,
            resources: exporterResources,
            env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
            ports: [{ name: "metrics", containerPort: 9121 }],
            readinessProbe: { httpGet: { path: "/metrics", port: "metrics" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { httpGet: { path: "/metrics", port: "metrics" }, initialDelaySeconds: 15, periodSeconds: 20 },
          },
        ],
      },
    },
  },
}, { dependsOn: [guestbookNamespace, guestbookQuota] });

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
    labels: { ...redisReplicaLabels, ...commonMetadataLabels },
  },
  spec: {
    selector: { matchLabels: redisReplicaLabels },
    template: {
      metadata: { labels: redisReplicaLabels },
      spec: {
        containers: [
          {
            name: "replica",
            image: redisReplicaImage,
            resources: redisResources,
            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
            ports: [{ name: "redis", containerPort: 6379 }],
            readinessProbe: { tcpSocket: { port: "redis" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { tcpSocket: { port: "redis" }, initialDelaySeconds: 15, periodSeconds: 20 },
          },
          {
            name: "redis-exporter",
            image: redisExporterImage,
            resources: exporterResources,
            env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
            ports: [{ name: "metrics", containerPort: 9121 }],
            readinessProbe: { httpGet: { path: "/metrics", port: "metrics" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { httpGet: { path: "/metrics", port: "metrics" }, initialDelaySeconds: 15, periodSeconds: 20 },
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
    labels: { ...frontendLabels, ...commonMetadataLabels },
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
            image: frontendImage,
            resources: frontendResources,
            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
            ports: [{ name: "app", containerPort: 80 }],
            readinessProbe: { httpGet: { path: "/", port: "app" }, initialDelaySeconds: 10, periodSeconds: 10 },
            livenessProbe: { httpGet: { path: "/", port: "app" }, initialDelaySeconds: 30, periodSeconds: 20 },
            startupProbe: { httpGet: { path: "/", port: "app" }, failureThreshold: 30, periodSeconds: 5 },
          },
          {
            name: "nginx-proxy",
            image: nginxImage,
            resources: exporterResources,
            ports: [{ name: "http", containerPort: 8080 }],
            readinessProbe: { httpGet: { path: "/nginx_status", port: "http" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { httpGet: { path: "/nginx_status", port: "http" }, initialDelaySeconds: 15, periodSeconds: 20 },
            volumeMounts: [{ name: "nginx-config", mountPath: "/etc/nginx/conf.d" }],
          },
          {
            name: "nginx-exporter",
            image: nginxExporterImage,
            args: ["--nginx.scrape-uri=http://127.0.0.1:8080/nginx_status"],
            resources: exporterResources,
            ports: [{ name: "metrics", containerPort: 9113 }],
            readinessProbe: { httpGet: { path: "/metrics", port: "metrics" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { httpGet: { path: "/metrics", port: "metrics" }, initialDelaySeconds: 15, periodSeconds: 20 },
          },
        ],
        volumes: [{ name: "nginx-config", configMap: { name: nginxConfig.metadata.name } }],
      },
    },
  },
}, { dependsOn: [redisReplicaService, nginxConfig] });

const frontendService = new k8s.core.v1.Service("frontend", {
  metadata: {
    name: "frontend",
    namespace: guestbookNamespace.metadata.name,
    labels: frontendLabels,
  },
  spec: {
    type: isMinikube ? "NodePort" : "LoadBalancer",
    ports: [
      { name: "http", port: 80, targetPort: "http" },
      { name: "metrics", port: 9113, targetPort: "metrics" },
    ],
    selector: frontendLabels,
  },
}, { dependsOn: frontendDeployment });

new k8s.autoscaling.v2.HorizontalPodAutoscaler("frontend-hpa", {
  metadata: {
    name: "frontend",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    scaleTargetRef: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      name: frontendDeployment.metadata.name,
    },
    minReplicas: 3,
    maxReplicas: 6,
    metrics: [{
      type: "Resource",
      resource: {
        name: "cpu",
        target: {
          type: "Utilization",
          averageUtilization: 60,
        },
      },
    }],
  },
}, { dependsOn: frontendDeployment });

new k8s.policy.v1.PodDisruptionBudget("frontend-pdb", {
  metadata: {
    name: "frontend",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    minAvailable: 2,
    selector: { matchLabels: frontendLabels },
  },
}, { dependsOn: frontendDeployment });

new k8s.policy.v1.PodDisruptionBudget("redis-replica-pdb", {
  metadata: {
    name: "redis-replica",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: redisReplicaLabels },
  },
}, { dependsOn: redisReplicaDeployment });

const blackboxConfig = new k8s.core.v1.ConfigMap("blackbox-exporter-config", {
  metadata: {
    name: "blackbox-exporter-config",
    namespace: monitoringNamespace.metadata.name,
  },
  data: {
    "blackbox.yml": `modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_http_versions:
        - HTTP/1.1
        - HTTP/2.0
      valid_status_codes: []
      method: GET
      preferred_ip_protocol: ip4
`,
  },
}, { dependsOn: monitoringNamespace });

const blackboxLabels = { app: "blackbox-exporter" };
const blackboxDeployment = new k8s.apps.v1.Deployment("blackbox-exporter", {
  metadata: {
    namespace: monitoringNamespace.metadata.name,
    labels: { ...blackboxLabels, ...commonMetadataLabels },
  },
  spec: {
    selector: { matchLabels: blackboxLabels },
    replicas: 2,
    template: {
      metadata: { labels: blackboxLabels },
      spec: {
        containers: [
          {
            name: "blackbox-exporter",
            image: blackboxExporterImage,
            args: ["--config.file=/etc/blackbox_exporter/blackbox.yml"],
            resources: exporterResources,
            ports: [{ name: "http", containerPort: 9115 }],
            readinessProbe: { httpGet: { path: "/-/healthy", port: "http" }, initialDelaySeconds: 5, periodSeconds: 10 },
            livenessProbe: { httpGet: { path: "/-/healthy", port: "http" }, initialDelaySeconds: 15, periodSeconds: 20 },
            volumeMounts: [{ name: "config", mountPath: "/etc/blackbox_exporter" }],
          },
        ],
        volumes: [{ name: "config", configMap: { name: blackboxConfig.metadata.name } }],
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

new k8s.policy.v1.PodDisruptionBudget("blackbox-pdb", {
  metadata: {
    name: "blackbox-exporter",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: blackboxLabels },
  },
}, { dependsOn: blackboxDeployment });

function serviceMonitor(resourceName: string, metadataName: string, namespaceName: pulumi.Input<string>, appLabel: string) {
  return new k8s.apiextensions.CustomResource(resourceName, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
      name: metadataName,
      namespace: monitoringNamespace.metadata.name,
      labels: monitorLabels,
    },
    spec: {
      namespaceSelector: { matchNames: [namespaceName] },
      selector: { matchLabels: { app: appLabel } },
      endpoints: [{ port: "metrics", path: "/metrics", interval: "15s" }],
    },
  }, { dependsOn: monitoringStack });
}

serviceMonitor("redis-leader-servicemonitor", "redis-leader", guestbookNamespace.metadata.name, "redis-leader");
serviceMonitor("redis-replica-servicemonitor", "redis-replica", guestbookNamespace.metadata.name, "redis-replica");
serviceMonitor("frontend-servicemonitor", "frontend", guestbookNamespace.metadata.name, "frontend");

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
        static: [pulumi.interpolate`http://${frontendService.metadata.name}.${guestbookNamespace.metadata.name}.svc.cluster.local`],
      },
    },
  },
}, { dependsOn: [monitoringStack, blackboxService, frontendService] });

new k8s.apiextensions.CustomResource("guestbook-alerts", {
  apiVersion: "monitoring.coreos.com/v1",
  kind: "PrometheusRule",
  metadata: {
    name: "guestbook-alerts",
    namespace: monitoringNamespace.metadata.name,
    labels: monitorLabels,
  },
  spec: {
    groups: [{
      name: "guestbook.rules",
      rules: [
        {
          alert: "FrontendDown",
          expr: 'probe_success{job="guestbook-frontend"} == 0',
          for: "2m",
          labels: { severity: "critical" },
          annotations: {
            summary: "Guestbook frontend is not reachable",
            description: "Blackbox probing has failed for the Guestbook frontend for more than two minutes.",
          },
        },
        {
          alert: "RedisDown",
          expr: `redis_up{namespace="${guestbookNamespaceName}"} == 0`,
          for: "2m",
          labels: { severity: "critical" },
          annotations: {
            summary: "Guestbook Redis is down",
            description: "A Redis exporter reports that Redis is unavailable.",
          },
        },
        {
          alert: "GuestbookHighCPU",
          expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${guestbookNamespaceName}",container!="",pod!=""}[5m])) > 0.4`,
          for: "5m",
          labels: { severity: "warning" },
          annotations: {
            summary: "Guestbook pod CPU is high",
            description: "A Guestbook pod has sustained high CPU usage for more than five minutes.",
          },
        },
      ],
    }],
  },
}, { dependsOn: monitoringStack });

new k8s.networking.v1.NetworkPolicy("guestbook-default-deny", {
  metadata: {
    name: "default-deny",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    podSelector: {},
    policyTypes: ["Ingress", "Egress"],
  },
}, { dependsOn: guestbookNamespace });

new k8s.networking.v1.NetworkPolicy("monitoring-default-deny", {
  metadata: {
    name: "default-deny",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    podSelector: {},
    policyTypes: ["Ingress", "Egress"],
  },
}, { dependsOn: monitoringNamespace });

new k8s.networking.v1.NetworkPolicy("frontend-network-policy", {
  metadata: {
    name: "frontend-network-policy",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    podSelector: { matchLabels: frontendLabels },
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      { from: [{ namespaceSelector: {} }], ports: [{ protocol: "TCP", port: 8080 }, { protocol: "TCP", port: 9113 }] },
    ],
    egress: [
      { to: [{ podSelector: { matchLabels: redisLeaderLabels } }, { podSelector: { matchLabels: redisReplicaLabels } }], ports: [{ protocol: "TCP", port: 6379 }] },
      { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
    ],
  },
}, { dependsOn: frontendDeployment });

new k8s.networking.v1.NetworkPolicy("redis-network-policy", {
  metadata: {
    name: "redis-network-policy",
    namespace: guestbookNamespace.metadata.name,
  },
  spec: {
    podSelector: { matchExpressions: [{ key: "app", operator: "In", values: ["redis-leader", "redis-replica"] }] },
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      { from: [{ podSelector: { matchLabels: frontendLabels } }], ports: [{ protocol: "TCP", port: 6379 }] },
      { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": monitoringNamespaceName } } }], ports: [{ protocol: "TCP", port: 9121 }] },
    ],
    egress: [
      { to: [{ podSelector: { matchLabels: redisLeaderLabels } }], ports: [{ protocol: "TCP", port: 6379 }] },
      { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
    ],
  },
}, { dependsOn: [redisLeaderDeployment, redisReplicaDeployment] });

new k8s.networking.v1.NetworkPolicy("blackbox-network-policy", {
  metadata: {
    name: "blackbox-network-policy",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    podSelector: { matchLabels: blackboxLabels },
    policyTypes: ["Ingress", "Egress"],
    ingress: [{ from: [{ namespaceSelector: {} }], ports: [{ protocol: "TCP", port: 9115 }] }],
    egress: [
      { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": guestbookNamespaceName } } }], ports: [{ protocol: "TCP", port: 80 }] },
      { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
    ],
  },
}, { dependsOn: blackboxDeployment });

new k8s.networking.v1.NetworkPolicy("monitoring-egress-policy", {
  metadata: {
    name: "monitoring-egress-policy",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    podSelector: {},
    policyTypes: ["Egress"],
    egress: [
      { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": guestbookNamespaceName } } }], ports: [{ protocol: "TCP", port: 9113 }, { protocol: "TCP", port: 9121 }, { protocol: "TCP", port: 80 }] },
      { to: [{ namespaceSelector: {} }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }, { protocol: "TCP", port: 443 }] },
    ],
  },
}, { dependsOn: monitoringNamespace });

new k8s.policy.v1.PodDisruptionBudget("grafana-pdb", {
  metadata: {
    name: "grafana",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    minAvailable: 1,
    selector: {
      matchLabels: {
        "app.kubernetes.io/name": "grafana",
        "app.kubernetes.io/instance": "monitoring",
      },
    },
  },
}, { dependsOn: monitoringStack });

new k8s.policy.v1.PodDisruptionBudget("prometheus-pdb", {
  metadata: {
    name: "prometheus",
    namespace: monitoringNamespace.metadata.name,
  },
  spec: {
    minAvailable: 1,
    selector: {
      matchLabels: {
        "app.kubernetes.io/name": "prometheus",
        "prometheus": "monitoring-kube-prometheus-prometheus",
      },
    },
  },
}, { dependsOn: monitoringStack });

const grafanaServiceSelector = "app.kubernetes.io/name=grafana";
const grafanaSecretSelector = "app.kubernetes.io/name=grafana,app.kubernetes.io/component=admin-secret";
const prometheusServiceSelector = "app=kube-prometheus-stack-prometheus";

export const frontendServiceName = frontendService.metadata.name;
export const frontendNamespace = guestbookNamespace.metadata.name;
export const frontendUrl = isMinikube
  ? "http://localhost:8080"
  : frontendService.status.loadBalancer.ingress.apply(ingress =>
    `http://${ingress[0].hostname ?? ingress[0].ip}`);
export const frontendPortForwardCommand = pulumi.interpolate`kubectl -n ${guestbookNamespace.metadata.name} port-forward svc/${frontendService.metadata.name} 8080:80`;
export const grafanaServiceSelectorOutput = grafanaServiceSelector;
export const grafanaNamespace = monitoringNamespace.metadata.name;
export const grafanaUrl = isMinikube
  ? "http://localhost:3000"
  : pulumi.interpolate`use: kubectl -n ${monitoringNamespace.metadata.name} get svc -l ${grafanaServiceSelector} -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}{.items[0].status.loadBalancer.ingress[0].ip}'`;
export const grafanaPortForwardCommand = pulumi.interpolate`kubectl -n ${monitoringNamespace.metadata.name} port-forward svc/$(kubectl -n ${monitoringNamespace.metadata.name} get svc -l ${grafanaServiceSelector} -o jsonpath='{.items[0].metadata.name}') 3000:80`;
export const grafanaUsername = grafanaAdminUser;
export const grafanaPasswordSecretCommand = pulumi.interpolate`kubectl -n ${monitoringNamespace.metadata.name} get secret -l ${grafanaSecretSelector} -o jsonpath='{.items[0].data.admin-password}' | base64 --decode`;
export const prometheusVerification = pulumi.interpolate`kubectl -n ${monitoringNamespace.metadata.name} port-forward svc/$(kubectl -n ${monitoringNamespace.metadata.name} get svc -l ${prometheusServiceSelector} -o jsonpath='{.items[0].metadata.name}') 9090:9090`;
