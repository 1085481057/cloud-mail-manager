// Public self-hosting template. Replace these values after deploying your Worker.
// Do not commit a configured copy to a public fork.
export const DEPLOYMENT = {
  workerOrigin: "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev",
  relayClientSecret: "REPLACE_WITH_YOUR_RELAY_CLIENT_SECRET",
  gmailEnabled: false,
  microsoftEnabled: false,
  imapEnabled: false,
} as const

export function deploymentConfigured() {
  return /^https:\/\/[^/]+$/i.test(DEPLOYMENT.workerOrigin)
    && !DEPLOYMENT.workerOrigin.includes("YOUR_")
    && DEPLOYMENT.relayClientSecret.length >= 32
    && !DEPLOYMENT.relayClientSecret.startsWith("REPLACE_")
}
