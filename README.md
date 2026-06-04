# Guestbook Monitoring with Pulumi, Prometheus, and Grafana

This project extends the Pulumi Kubernetes Guestbook example with Prometheus and Grafana monitoring.

It deploys:

- Guestbook frontend, Redis leader, and Redis replica services.
- `kube-prometheus-stack` via the Prometheus Community Helm chart.
- Redis exporters as sidecars for the Guestbook backend.
- `ServiceMonitor` resources for Redis leader and Redis replica metrics.
- A Blackbox Exporter probe for frontend HTTP availability.
- A Grafana dashboard for frontend probe status, pod CPU, pod memory, and Redis client metrics.

## Prerequisites

- A Kubernetes cluster available through the current `kubectl` context.
- Pulumi CLI.
- Node.js and npm.
- Helm access from Pulumi to `https://prometheus-community.github.io/helm-charts`.

For Minikube or Docker Desktop, keep `isMinikube=true` so Grafana and the frontend use NodePort services. For cloud clusters, set it to `false` to use LoadBalancer services.

## Deploy

```bash
npm install
pulumi stack init dev
pulumi config set isMinikube true
pulumi config set --secret grafanaAdminPassword 'change-me'
pulumi up
```

For a cloud cluster:

```bash
pulumi config set isMinikube false
pulumi up
```

## Access Grafana

Pulumi exports:

- `grafanaUrl`
- `grafanaUsername`
- `grafanaPassword`
- `grafanaServiceName`
- `grafanaNamespace`
- `grafanaPortForwardCommand`

Default username:

```text
admin
```

The password is the value configured with:

```bash
pulumi config set --secret grafanaAdminPassword 'change-me'
```

For local clusters, use the exported port-forward command:

```bash
pulumi stack output grafanaPortForwardCommand
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
```

Open `http://localhost:3000` and sign in with the Grafana credentials above.

## Verify Prometheus Scraping

Port-forward Prometheus:

```bash
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open `http://localhost:9090/targets` and check for:

- `serviceMonitor/monitoring/redis-leader`
- `serviceMonitor/monitoring/redis-replica`
- `probe/monitoring/guestbook-frontend`

Useful Prometheus queries:

```promql
up{namespace="guestbook"}
redis_up{namespace="guestbook"}
redis_connected_clients{namespace="guestbook"}
probe_success{job="guestbook-frontend"}
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",container!="",pod!=""}[5m]))
sum by (pod) (container_memory_working_set_bytes{namespace="guestbook",container!="",pod!=""})
```

## Access the Guestbook

Pulumi exports:

- `frontendUrl`
- `frontendServiceName`
- `frontendNamespace`
- `frontendPortForwardCommand`

For local clusters, use the exported port-forward command:

```bash
pulumi stack output frontendPortForwardCommand
kubectl -n guestbook port-forward svc/frontend 8080:80
```

Open `http://localhost:8080`.

## Dashboard

Grafana automatically imports the `Guestbook Overview` dashboard from a Kubernetes ConfigMap. It shows:

- Frontend HTTP probe success.
- Guestbook pod CPU usage.
- Guestbook pod memory usage.
- Redis connected clients from the Redis exporter.

## Notes

The stock `pulumi/guestbook-php-redis` frontend image does not expose native Prometheus application metrics. This implementation monitors frontend availability with Blackbox Exporter and uses Prometheus/Kubernetes resource metrics for frontend CPU and memory. Redis backend metrics are exported directly from Redis exporter sidecars and scraped by Prometheus with `ServiceMonitor` resources.

## References

- Pulumi Guestbook example: <https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook>
- kube-prometheus-stack Helm chart: <https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack>
- Prometheus Operator custom resources: <https://prometheus-operator.dev/docs/api-reference/api/>

## Cleanup

```bash
pulumi destroy
pulumi stack rm dev
```

