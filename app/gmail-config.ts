import { DEPLOYMENT, deploymentConfigured } from "./deployment-config"

export const GMAIL_OAUTH_RELAY = {
  origin: DEPLOYMENT.workerOrigin,
  clientSecret: DEPLOYMENT.relayClientSecret,
} as const

export function gmailOAuthConfigured() {
  return DEPLOYMENT.gmailEnabled && deploymentConfigured()
}
