import { DEPLOYMENT, deploymentConfigured } from "./deployment-config"

export const MAIL_GATEWAY = {
  origin: DEPLOYMENT.workerOrigin,
  imapEnabled: DEPLOYMENT.imapEnabled,
} as const

export function imapGatewayConfigured() {
  return MAIL_GATEWAY.imapEnabled && deploymentConfigured()
}
