import { DEPLOYMENT, deploymentConfigured } from "./deployment-config"

export const MICROSOFT_OAUTH = {
  origin: DEPLOYMENT.workerOrigin,
  relayClientSecret: DEPLOYMENT.relayClientSecret,
  enabled: DEPLOYMENT.microsoftEnabled,
} as const

export function microsoftOAuthConfigured() {
  return MICROSOFT_OAUTH.enabled && deploymentConfigured()
}
